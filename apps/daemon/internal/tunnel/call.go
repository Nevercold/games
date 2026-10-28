package tunnel

import (
	"context"
	"errors"
	"fmt"
	"sync"

	"google.golang.org/protobuf/proto"

	panelv1 "panel/daemon/internal/pb/panel/v1"
)

// ErrNotConnected is returned by Call while no tunnel is up.
var ErrNotConnected = errors.New("tunnel not connected")

// outgoing tracks streams the daemon opened (even ids) for daemon→panel RPCs.
type outgoing struct {
	mu      sync.Mutex
	nextID  uint32
	pending map[uint32]chan callResult
}

type callResult struct {
	data []byte
	err  error
}

func newOutgoing() *outgoing {
	return &outgoing{nextID: 2, pending: map[uint32]chan callResult{}}
}

func (o *outgoing) open() (uint32, chan callResult) {
	o.mu.Lock()
	defer o.mu.Unlock()
	id := o.nextID
	o.nextID += 2
	ch := make(chan callResult, 1)
	o.pending[id] = ch
	return id, ch
}

func (o *outgoing) resolve(id uint32, res callResult) {
	o.mu.Lock()
	ch, ok := o.pending[id]
	delete(o.pending, id)
	o.mu.Unlock()
	if ok {
		ch <- res
	}
}

func (o *outgoing) failAll(err error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	for id, ch := range o.pending {
		ch <- callResult{err: err}
		delete(o.pending, id)
	}
}

// Call performs an RPC against the panel ("rpc:<method>") over the current
// tunnel. The request travels as stream header, the panel answers with one
// data frame or a TunnelError.
func (c *Client) Call(ctx context.Context, method string, req, res proto.Message) error {
	c.mu.Lock()
	s := c.current
	c.mu.Unlock()
	if s == nil {
		return ErrNotConnected
	}
	header, err := proto.Marshal(req)
	if err != nil {
		return err
	}
	id, ch := s.out.open()
	if err := s.send(ctx, &panelv1.Envelope{StreamId: id, Payload: &panelv1.Envelope_StreamOpen{
		StreamOpen: &panelv1.StreamOpen{Kind: "rpc:" + method, Header: header},
	}}); err != nil {
		s.out.resolve(id, callResult{err: err})
		return err
	}
	select {
	case <-ctx.Done():
		s.out.resolve(id, callResult{err: ctx.Err()})
		return ctx.Err()
	case r := <-ch:
		if r.err != nil {
			return r.err
		}
		if err := proto.Unmarshal(r.data, res); err != nil {
			return fmt.Errorf("decode %s response: %w", method, err)
		}
		return nil
	}
}

// handleOutgoingFrame routes panel replies for daemon-opened streams.
func (s *session) handleOutgoingFrame(env *panelv1.Envelope) {
	switch p := env.Payload.(type) {
	case *panelv1.Envelope_StreamData:
		s.out.resolve(env.StreamId, callResult{data: p.StreamData.Data})
	case *panelv1.Envelope_StreamClose:
		s.out.resolve(env.StreamId, callResult{err: errors.New("stream closed without response")})
	case *panelv1.Envelope_Error:
		s.out.resolve(env.StreamId, callResult{err: &Error{Code: p.Error.Code, Message: p.Error.Message}})
	}
}
