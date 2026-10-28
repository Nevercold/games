// Package tunnel maintains the outbound websocket connection to the panel
// (PLAN.md "Tunnel-Modell"). The daemon dials out; the panel never connects
// to the node, so nodes need no public address or TLS certificate.
package tunnel

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"math/rand/v2"
	"net/http"
	"sync"
	"time"

	"github.com/coder/websocket"
	"google.golang.org/protobuf/proto"

	panelv1 "panel/daemon/internal/pb/panel/v1"
	"panel/daemon/internal/sysinfo"
)

// ProtocolVersion must match PROTOCOL_VERSION in @panel/shared.
const ProtocolVersion = 0

const (
	handshakeTimeout   = 10 * time.Second
	writeTimeout       = 10 * time.Second
	defaultHeartbeat   = 15 * time.Second
	minBackoff         = 1 * time.Second
	maxBackoff         = 60 * time.Second
	maxFrameBytes      = 16 << 20
	stableConnDuration = 30 * time.Second
	maxStreams         = 1024
)

// Options configures the tunnel client.
type Options struct {
	URL           string
	Token         string
	DaemonVersion string
	DockerSocket  string
	Logger        *slog.Logger
	// Handlers serve panel-opened streams, keyed by StreamOpen.kind.
	Handlers map[string]Handler
}

// Client keeps one tunnel to the panel alive until its context is cancelled.
type Client struct {
	opts Options
	log  *slog.Logger

	mu      sync.Mutex
	current *session
}

// New creates a tunnel client.
func New(opts Options) *Client {
	return &Client{opts: opts, log: opts.Logger}
}

// Emit sends an event to the panel. Events are dropped while disconnected;
// the panel resynchronises state via rpc:states after reconnecting.
func (c *Client) Emit(evt *panelv1.Event) {
	c.mu.Lock()
	s := c.current
	c.mu.Unlock()
	if s == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), writeTimeout)
	defer cancel()
	if err := s.send(ctx, &panelv1.Envelope{Payload: &panelv1.Envelope_Event{Event: evt}}); err != nil {
		c.log.Debug("emit failed", "err", err)
	}
}

// errPermanent marks failures where retrying with the same config is futile.
var errPermanent = errors.New("permanent tunnel error")

// Run connects and reconnects with exponential backoff until ctx is done.
// It returns early only for permanent errors such as a rejected token.
func (c *Client) Run(ctx context.Context) error {
	backoff := minBackoff
	for {
		started := time.Now()
		err := c.session(ctx)
		if ctx.Err() != nil {
			return nil
		}
		if errors.Is(err, errPermanent) {
			return err
		}
		// A connection that stayed up for a while resets the backoff.
		if time.Since(started) > stableConnDuration {
			backoff = minBackoff
		}
		wait := backoff/2 + rand.N(backoff/2+1) // jitter: 50–100 % of backoff
		c.log.Warn("tunnel disconnected, reconnecting", "err", err, "in", wait.Round(time.Millisecond))
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(wait):
		}
		backoff = min(backoff*2, maxBackoff)
	}
}

// session runs a single connection from dial to disconnect.
func (c *Client) session(ctx context.Context) error {
	dialCtx, cancelDial := context.WithTimeout(ctx, handshakeTimeout)
	defer cancelDial()

	conn, resp, err := websocket.Dial(dialCtx, c.opts.URL, &websocket.DialOptions{
		HTTPHeader: http.Header{"Authorization": []string{"Bearer " + c.opts.Token}},
	})
	if err != nil {
		if resp != nil && resp.StatusCode == http.StatusUnauthorized {
			return fmt.Errorf("%w: panel rejected the node token (401)", errPermanent)
		}
		return fmt.Errorf("dial: %w", err)
	}
	defer conn.CloseNow()
	conn.SetReadLimit(maxFrameBytes)

	sessCtx, cancel := context.WithCancel(ctx)
	defer cancel()

	s := &session{
		conn:     conn,
		log:      c.log,
		handlers: c.opts.Handlers,
		streams:  map[uint32]*Stream{},
		ctx:      sessCtx,
	}
	defer s.closeAllStreams()

	// Handshake: Hello → HelloAck.
	info := sysinfo.Collect(ctx, c.opts.DockerSocket)
	if err := s.send(ctx, &panelv1.Envelope{Payload: &panelv1.Envelope_Hello{Hello: &panelv1.Hello{
		ProtocolVersion: ProtocolVersion,
		DaemonVersion:   c.opts.DaemonVersion,
		Hostname:        info.Hostname,
		System: &panelv1.SystemInfo{
			Os:               info.OS,
			Arch:             info.Arch,
			Kernel:           info.Kernel,
			MemoryTotalBytes: info.MemoryTotalBytes,
			CpuCount:         info.CPUCount,
			DockerVersion:    info.DockerVersion,
		},
	}}}); err != nil {
		return fmt.Errorf("send hello: %w", err)
	}

	hsCtx, cancelHs := context.WithTimeout(ctx, handshakeTimeout)
	env, err := s.read(hsCtx)
	cancelHs()
	if err != nil {
		return fmt.Errorf("read hello ack: %w", err)
	}
	var ack *panelv1.HelloAck
	switch p := env.Payload.(type) {
	case *panelv1.Envelope_HelloAck:
		ack = p.HelloAck
	case *panelv1.Envelope_Error:
		return fmt.Errorf("%w: panel refused handshake: %d %s", errPermanent, p.Error.Code, p.Error.Message)
	default:
		return fmt.Errorf("unexpected frame during handshake: %T", env.Payload)
	}

	heartbeat := time.Duration(ack.HeartbeatIntervalS) * time.Second
	if heartbeat <= 0 {
		heartbeat = defaultHeartbeat
	}
	c.log.Info("tunnel connected",
		"node", ack.NodeId, "panel_version", ack.PanelVersion, "heartbeat", heartbeat)

	c.mu.Lock()
	c.current = s
	c.mu.Unlock()
	defer func() {
		c.mu.Lock()
		if c.current == s {
			c.current = nil
		}
		c.mu.Unlock()
	}()

	errCh := make(chan error, 2)
	go func() { errCh <- s.heartbeatLoop(sessCtx, heartbeat) }()
	go func() { errCh <- s.readLoop(sessCtx, heartbeat*3) }()

	select {
	case <-ctx.Done():
		_ = conn.Close(websocket.StatusGoingAway, "daemon shutting down")
		return nil
	case err := <-errCh:
		return err
	}
}

type session struct {
	conn     *websocket.Conn
	log      *slog.Logger
	handlers map[string]Handler
	ctx      context.Context
	writeMu  sync.Mutex

	streamsMu sync.Mutex
	streams   map[uint32]*Stream
}

func (s *session) send(ctx context.Context, env *panelv1.Envelope) error {
	data, err := proto.Marshal(env)
	if err != nil {
		return err
	}
	wctx, cancel := context.WithTimeout(ctx, writeTimeout)
	defer cancel()
	s.writeMu.Lock()
	defer s.writeMu.Unlock()
	return s.conn.Write(wctx, websocket.MessageBinary, data)
}

func (s *session) read(ctx context.Context) (*panelv1.Envelope, error) {
	typ, data, err := s.conn.Read(ctx)
	if err != nil {
		return nil, err
	}
	if typ != websocket.MessageBinary {
		return nil, errors.New("expected binary frame")
	}
	env := &panelv1.Envelope{}
	if err := proto.Unmarshal(data, env); err != nil {
		return nil, fmt.Errorf("decode envelope: %w", err)
	}
	return env, nil
}

func (s *session) heartbeatLoop(ctx context.Context, every time.Duration) error {
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return nil
		case <-t.C:
			ping := &panelv1.Envelope{Payload: &panelv1.Envelope_Ping{Ping: &panelv1.Ping{SentUnixMs: time.Now().UnixMilli()}}}
			if err := s.send(ctx, ping); err != nil {
				return fmt.Errorf("send ping: %w", err)
			}
		}
	}
}

// readLoop handles inbound frames. idleTimeout closes half-open connections
// when the panel stops answering pings.
func (s *session) readLoop(ctx context.Context, idleTimeout time.Duration) error {
	for {
		rctx, cancel := context.WithTimeout(ctx, idleTimeout)
		env, err := s.read(rctx)
		cancel()
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			return fmt.Errorf("read: %w", err)
		}
		switch p := env.Payload.(type) {
		case *panelv1.Envelope_Pong:
			s.log.Debug("pong", "rtt_ms", time.Now().UnixMilli()-p.Pong.SentUnixMs)
		case *panelv1.Envelope_StreamOpen:
			s.openStream(env.StreamId, p.StreamOpen)
		case *panelv1.Envelope_StreamData:
			s.deliver(env.StreamId, p.StreamData)
		case *panelv1.Envelope_StreamClose:
			s.cancelStream(env.StreamId)
		case *panelv1.Envelope_Error:
			if env.StreamId != 0 {
				s.cancelStream(env.StreamId)
			} else {
				s.log.Warn("panel error", "code", p.Error.Code, "message", p.Error.Message)
			}
		default:
			s.log.Debug("ignoring frame", "type", fmt.Sprintf("%T", env.Payload))
		}
	}
}

func (s *session) openStream(id uint32, open *panelv1.StreamOpen) {
	fail := func(code uint32, msg string) {
		_ = s.send(s.ctx, &panelv1.Envelope{StreamId: id, Payload: &panelv1.Envelope_Error{
			Error: &panelv1.TunnelError{Code: code, Message: msg},
		}})
	}
	// Panel-opened streams use odd ids (see tunnel.proto).
	if id == 0 || id%2 == 0 {
		fail(400, "invalid stream id")
		return
	}
	handler, ok := s.handlers[open.Kind]
	if !ok {
		fail(501, "unsupported stream kind: "+open.Kind)
		return
	}

	s.streamsMu.Lock()
	if _, exists := s.streams[id]; exists || len(s.streams) >= maxStreams {
		s.streamsMu.Unlock()
		fail(409, "stream id in use or too many streams")
		return
	}
	ctx, cancel := context.WithCancel(s.ctx)
	st := &Stream{ID: id, Kind: open.Kind, Header: open.Header, in: make(chan []byte, 64), sess: s, ctx: ctx, cancel: cancel}
	s.streams[id] = st
	s.streamsMu.Unlock()

	go func() {
		defer s.removeStream(id)
		defer cancel()
		err := handler(ctx, st)
		st.finish(err)
	}()
}

func (s *session) deliver(id uint32, data *panelv1.StreamData) {
	s.streamsMu.Lock()
	st := s.streams[id]
	s.streamsMu.Unlock()
	if st == nil {
		return
	}
	// Never block the read loop: a stream that cannot keep up loses input.
	if len(data.Data) > 0 && !st.push(data.Data) {
		s.log.Warn("stream input dropped", "stream", id, "kind", st.Kind)
	}
	if data.Eof {
		st.closeInput()
	}
}

func (s *session) cancelStream(id uint32) {
	s.streamsMu.Lock()
	st := s.streams[id]
	s.streamsMu.Unlock()
	if st != nil {
		st.remoteClosed.Store(true)
		st.cancel()
	}
}

func (s *session) removeStream(id uint32) {
	s.streamsMu.Lock()
	delete(s.streams, id)
	s.streamsMu.Unlock()
}

func (s *session) closeAllStreams() {
	s.streamsMu.Lock()
	defer s.streamsMu.Unlock()
	for _, st := range s.streams {
		st.remoteClosed.Store(true)
		st.cancel()
	}
}
