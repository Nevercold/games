package tunnel

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"

	"google.golang.org/protobuf/proto"

	panelv1 "panel/daemon/internal/pb/panel/v1"
)

// Handler serves one stream opened by the panel. Returning nil closes the
// stream normally; returning an error sends it to the panel as TunnelError.
type Handler func(ctx context.Context, s *Stream) error

// Stream is one multiplexed channel inside the tunnel.
type Stream struct {
	ID     uint32
	Kind   string
	Header []byte

	in           chan []byte
	inMu         sync.Mutex
	inClosed     bool
	sess         *session
	ctx          context.Context
	cancel       context.CancelFunc
	finished     atomic.Bool
	remoteClosed atomic.Bool
}

// Recv yields data frames sent by the panel. The channel closes on EOF.
func (s *Stream) Recv() <-chan []byte { return s.in }

// push queues inbound data without blocking. It reports false when the
// stream is closed for input or its buffer is full.
func (s *Stream) push(data []byte) bool {
	s.inMu.Lock()
	defer s.inMu.Unlock()
	if s.inClosed {
		return false
	}
	select {
	case s.in <- data:
		return true
	default:
		return false
	}
}

func (s *Stream) closeInput() {
	s.inMu.Lock()
	defer s.inMu.Unlock()
	if !s.inClosed {
		s.inClosed = true
		close(s.in)
	}
}

// Send writes a data frame to the panel.
func (s *Stream) Send(data []byte) error {
	return s.sess.send(s.ctx, &panelv1.Envelope{StreamId: s.ID, Payload: &panelv1.Envelope_StreamData{
		StreamData: &panelv1.StreamData{Data: data},
	}})
}

// Reply writes the final data frame (RPC response) and ends the stream.
func (s *Stream) Reply(data []byte) error {
	if !s.finished.CompareAndSwap(false, true) {
		return errors.New("stream already finished")
	}
	return s.sess.send(s.ctx, &panelv1.Envelope{StreamId: s.ID, Payload: &panelv1.Envelope_StreamData{
		StreamData: &panelv1.StreamData{Data: data, Eof: true},
	}})
}

// finish closes the stream after the handler returned.
func (s *Stream) finish(err error) {
	if s.remoteClosed.Load() || !s.finished.CompareAndSwap(false, true) {
		return
	}
	// The stream context is cancelled by now; use the session context so the
	// final frame still goes out.
	ctx := s.sess.ctx
	if err != nil {
		code, msg := uint32(500), err.Error()
		var e *Error
		if errors.As(err, &e) {
			code, msg = e.Code, e.Message
		}
		_ = s.sess.send(ctx, &panelv1.Envelope{StreamId: s.ID, Payload: &panelv1.Envelope_Error{
			Error: &panelv1.TunnelError{Code: code, Message: msg},
		}})
		return
	}
	_ = s.sess.send(ctx, &panelv1.Envelope{StreamId: s.ID, Payload: &panelv1.Envelope_StreamClose{
		StreamClose: &panelv1.StreamClose{},
	}})
}

// Error is a handler error with an HTTP-like status code for the panel.
type Error struct {
	Code    uint32
	Message string
}

func (e *Error) Error() string { return e.Message }

// Errorf-style helpers for common codes.
func BadRequest(msg string) error { return &Error{Code: 400, Message: msg} }
func NotFound(msg string) error   { return &Error{Code: 404, Message: msg} }
func Conflict(msg string) error   { return &Error{Code: 409, Message: msg} }

// RPC adapts a typed request/response function to a stream Handler.
func RPC[Req any, PReq interface {
	*Req
	proto.Message
}](fn func(ctx context.Context, req PReq) (proto.Message, error)) Handler {
	return func(ctx context.Context, s *Stream) error {
		req := PReq(new(Req))
		if err := proto.Unmarshal(s.Header, req); err != nil {
			return BadRequest("malformed request: " + err.Error())
		}
		res, err := fn(ctx, req)
		if err != nil {
			return err
		}
		data, err := proto.Marshal(res)
		if err != nil {
			return err
		}
		return s.Reply(data)
	}
}
