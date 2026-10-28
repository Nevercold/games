// Package servers runs game servers as Docker containers. The daemon keeps
// no database: the panel sends the full ServerSpec with every start/install,
// and the last spec is cached on disk so a daemon restart can re-attach.
package servers

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/docker/docker/api/types"
	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/filters"
	"github.com/docker/docker/api/types/image"
	"github.com/docker/docker/api/types/mount"
	"github.com/docker/docker/client"
	"github.com/docker/docker/pkg/stdcopy"
	"github.com/docker/go-connections/nat"
	"google.golang.org/protobuf/encoding/protojson"

	panelv1 "panel/daemon/internal/pb/panel/v1"
	"panel/daemon/internal/tunnel"
)

const (
	labelManaged = "panel.managed"
	labelServer  = "panel.server"
	labelInstall = "panel.install"
)

// Options configures the server manager.
type Options struct {
	Docker  *client.Client
	DataDir string
	// ContainerUser is "uid:gid" for game containers; empty uses the image user.
	ContainerUser string
	StopTimeout   time.Duration
	Logger        *slog.Logger
}

// Manager owns all servers on this node.
type Manager struct {
	opts   Options
	docker *client.Client
	log    *slog.Logger

	emitMu sync.RWMutex
	emit   func(*panelv1.Event)

	mu      sync.Mutex
	servers map[string]*Server
}

// NewManager prepares the data directory layout.
func NewManager(opts Options) (*Manager, error) {
	abs, err := filepath.Abs(opts.DataDir)
	if err != nil {
		return nil, err
	}
	opts.DataDir = abs
	for _, d := range []string{"servers", ".state", ".install"} {
		if err := os.MkdirAll(filepath.Join(abs, d), 0o755); err != nil {
			return nil, fmt.Errorf("create data dir: %w", err)
		}
	}
	if opts.StopTimeout <= 0 {
		opts.StopTimeout = 2 * time.Minute
	}
	return &Manager{opts: opts, docker: opts.Docker, log: opts.Logger, servers: map[string]*Server{}}, nil
}

// SetEmitter sets the event sink (the tunnel client).
func (m *Manager) SetEmitter(fn func(*panelv1.Event)) {
	m.emitMu.Lock()
	m.emit = fn
	m.emitMu.Unlock()
}

func (m *Manager) emitEvent(evt *panelv1.Event) {
	m.emitMu.RLock()
	fn := m.emit
	m.emitMu.RUnlock()
	if fn != nil {
		fn(evt)
	}
}

func (m *Manager) serverDir(id string) string  { return filepath.Join(m.opts.DataDir, "servers", id) }
func (m *Manager) installDir(id string) string { return filepath.Join(m.opts.DataDir, ".install", id) }
func (m *Manager) specFile(id string) string {
	return filepath.Join(m.opts.DataDir, ".state", id+".json")
}
func containerName(id string) string        { return "panel_" + id }
func installContainerName(id string) string { return "panel_install_" + id }

func (m *Manager) server(id string) (*Server, error) {
	if !validID.MatchString(id) {
		return nil, tunnel.BadRequest("invalid server id")
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	s, ok := m.servers[id]
	if !ok {
		s = &Server{id: id, m: m, console: newConsole(), state: panelv1.ServerState_SERVER_STATE_OFFLINE}
		m.servers[id] = s
	}
	return s, nil
}

// Server is the runtime state of one game server.
type Server struct {
	id      string
	m       *Manager
	console *Console

	mu            sync.Mutex
	state         panelv1.ServerState
	spec          *panelv1.ServerSpec
	hijack        *types.HijackedResponse
	stopRequested bool
	startedAt     time.Time
	exited        chan struct{}

	diskMu    sync.Mutex
	diskBytes uint64
	diskAt    time.Time
}

// State returns the current state.
func (s *Server) State() panelv1.ServerState {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.state
}

// setStateLocked must be called with s.mu held.
func (s *Server) setStateLocked(st panelv1.ServerState, crashed bool) {
	if s.state == st && !crashed {
		return
	}
	s.state = st
	go s.m.emitEvent(&panelv1.Event{Kind: &panelv1.Event_StateChanged{StateChanged: &panelv1.ServerStateChanged{
		ServerId: s.id, State: st, Crashed: crashed,
	}}})
}

func (s *Server) setState(st panelv1.ServerState, crashed bool) {
	s.mu.Lock()
	s.setStateLocked(st, crashed)
	s.mu.Unlock()
}

// ---------------------------------------------------------------------------
// Power
// ---------------------------------------------------------------------------

// Start launches the server asynchronously. Progress goes to the console
// and state events.
func (m *Manager) Start(spec *panelv1.ServerSpec) error {
	if spec == nil || spec.Image == "" {
		return tunnel.BadRequest("spec with image required")
	}
	s, err := m.server(spec.Id)
	if err != nil {
		return err
	}
	s.mu.Lock()
	if s.state != panelv1.ServerState_SERVER_STATE_OFFLINE {
		st := s.state
		s.mu.Unlock()
		return tunnel.Conflict("server is not offline (" + st.String() + ")")
	}
	s.spec = spec
	s.stopRequested = false
	s.setStateLocked(panelv1.ServerState_SERVER_STATE_STARTING, false)
	s.mu.Unlock()

	go s.run(spec)
	return nil
}

func (s *Server) run(spec *panelv1.ServerSpec) {
	m := s.m
	ctx := context.Background()
	fail := func(err error) {
		s.console.System("Start failed: " + err.Error())
		m.log.Warn("server start failed", "server", s.id, "err", err)
		s.setState(panelv1.ServerState_SERVER_STATE_OFFLINE, false)
	}
	aborted := func() bool {
		s.mu.Lock()
		defer s.mu.Unlock()
		return s.stopRequested
	}

	s.console.System("Starting server")
	dir := m.serverDir(s.id)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		fail(err)
		return
	}
	m.chown(dir, false)
	m.saveSpec(spec)

	if len(spec.ConfigFiles) > 0 {
		root, err := os.OpenRoot(dir)
		if err != nil {
			fail(err)
			return
		}
		for _, e := range applyConfigFiles(root, spec.ConfigFiles) {
			s.console.System("Config file warning: " + e.Error())
		}
		_ = root.Close()
	}

	if err := m.ensureImage(ctx, spec.Image, s.console); err != nil {
		fail(err)
		return
	}
	if aborted() {
		s.console.System("Start aborted")
		s.setState(panelv1.ServerState_SERVER_STATE_OFFLINE, false)
		return
	}

	name := containerName(s.id)
	_ = m.docker.ContainerRemove(ctx, name, container.RemoveOptions{Force: true})

	cfg, hostCfg := m.containerConfig(spec, dir)
	if _, err := m.docker.ContainerCreate(ctx, cfg, hostCfg, nil, nil, name); err != nil {
		fail(fmt.Errorf("create container: %w", err))
		return
	}
	hijack, err := m.docker.ContainerAttach(ctx, name, container.AttachOptions{
		Stream: true, Stdin: true, Stdout: true, Stderr: true,
	})
	if err != nil {
		fail(fmt.Errorf("attach: %w", err))
		return
	}
	if err := m.docker.ContainerStart(ctx, name, container.StartOptions{}); err != nil {
		hijack.Close()
		fail(fmt.Errorf("start container: %w", err))
		return
	}

	exited := make(chan struct{})
	s.mu.Lock()
	s.hijack = &hijack
	s.startedAt = time.Now()
	s.exited = exited
	if len(spec.Done) == 0 {
		s.setStateLocked(panelv1.ServerState_SERVER_STATE_RUNNING, false)
	}
	s.mu.Unlock()

	go s.pump(hijack.Reader, spec.Done)
	go s.waitExit(name, exited)
}

// pump copies container output to the console and detects "done" markers.
func (s *Server) pump(r io.Reader, done []string) {
	buf := make([]byte, 32<<10)
	var tail string
	for {
		n, err := r.Read(buf)
		if n > 0 {
			chunk := buf[:n]
			_, _ = s.console.Write(chunk)
			if len(done) > 0 {
				// Keep a little context so markers split across reads still match.
				tail += string(chunk)
				if len(tail) > 8192 {
					tail = tail[len(tail)-8192:]
				}
				s.mu.Lock()
				if s.state == panelv1.ServerState_SERVER_STATE_STARTING {
					for _, d := range done {
						if d != "" && strings.Contains(tail, d) {
							s.setStateLocked(panelv1.ServerState_SERVER_STATE_RUNNING, false)
							tail = ""
							break
						}
					}
				}
				s.mu.Unlock()
			}
		}
		if err != nil {
			return
		}
	}
}

func (s *Server) waitExit(name string, exited chan struct{}) {
	statusCh, errCh := s.m.docker.ContainerWait(context.Background(), name, container.WaitConditionNotRunning)
	code := int64(-1)
	select {
	case st := <-statusCh:
		code = st.StatusCode
	case err := <-errCh:
		s.m.log.Warn("container wait failed", "server", s.id, "err", err)
	}

	s.mu.Lock()
	crashed := !s.stopRequested
	if s.hijack != nil {
		s.hijack.Close()
		s.hijack = nil
	}
	s.exited = nil
	s.setStateLocked(panelv1.ServerState_SERVER_STATE_OFFLINE, crashed)
	s.mu.Unlock()
	close(exited)

	if crashed {
		s.console.System(fmt.Sprintf("Server exited unexpectedly (exit code %d)", code))
	} else {
		s.console.System(fmt.Sprintf("Server stopped (exit code %d)", code))
	}
}

// Stop asks the server to stop using its stop command or signal and kills it
// after the stop timeout.
func (m *Manager) Stop(id string) error {
	s, err := m.server(id)
	if err != nil {
		return err
	}
	s.mu.Lock()
	switch s.state {
	case panelv1.ServerState_SERVER_STATE_OFFLINE:
		s.mu.Unlock()
		return nil
	case panelv1.ServerState_SERVER_STATE_INSTALLING:
		s.mu.Unlock()
		return tunnel.Conflict("server is installing")
	}
	s.stopRequested = true
	spec, hijack, exited := s.spec, s.hijack, s.exited
	s.setStateLocked(panelv1.ServerState_SERVER_STATE_STOPPING, false)
	s.mu.Unlock()

	if exited == nil {
		// Still pulling or creating: run() sees stopRequested and aborts.
		return nil
	}
	s.console.System("Stopping server")
	name := containerName(id)
	cmd, sig := "", "SIGTERM"
	if spec != nil && spec.Stop != nil {
		switch k := spec.Stop.Kind.(type) {
		case *panelv1.StopConfig_Command:
			cmd = k.Command
		case *panelv1.StopConfig_Signal:
			sig = k.Signal
		}
	}
	if cmd != "" && hijack != nil {
		if _, err := hijack.Conn.Write([]byte(cmd + "\n")); err != nil {
			_ = m.docker.ContainerKill(context.Background(), name, sig)
		}
	} else {
		_ = m.docker.ContainerKill(context.Background(), name, sig)
	}

	go func() {
		select {
		case <-exited:
		case <-time.After(m.opts.StopTimeout):
			s.console.System("Server did not stop in time, killing it")
			_ = m.docker.ContainerKill(context.Background(), name, "SIGKILL")
		}
	}()
	return nil
}

// Kill terminates the container immediately.
func (m *Manager) Kill(id string) error {
	s, err := m.server(id)
	if err != nil {
		return err
	}
	s.mu.Lock()
	if s.state == panelv1.ServerState_SERVER_STATE_OFFLINE {
		s.mu.Unlock()
		return nil
	}
	if s.state == panelv1.ServerState_SERVER_STATE_INSTALLING {
		s.mu.Unlock()
		return tunnel.Conflict("server is installing")
	}
	s.stopRequested = true
	s.mu.Unlock()
	s.console.System("Killing server")
	err = m.docker.ContainerKill(context.Background(), containerName(id), "SIGKILL")
	if err != nil && !client.IsErrNotFound(err) {
		return err
	}
	return nil
}

// Restart stops the server (if running) and starts it with the given spec.
func (m *Manager) Restart(spec *panelv1.ServerSpec) error {
	if spec == nil {
		return tunnel.BadRequest("spec required")
	}
	s, err := m.server(spec.Id)
	if err != nil {
		return err
	}
	s.mu.Lock()
	state, exited := s.state, s.exited
	s.mu.Unlock()
	if state == panelv1.ServerState_SERVER_STATE_OFFLINE {
		return m.Start(spec)
	}
	if err := m.Stop(spec.Id); err != nil {
		return err
	}
	go func() {
		if exited != nil {
			<-exited
		} else {
			// Stopped while starting: wait until run() gave up.
			for s.State() != panelv1.ServerState_SERVER_STATE_OFFLINE {
				time.Sleep(200 * time.Millisecond)
			}
		}
		if err := m.Start(spec); err != nil {
			s.console.System("Restart failed: " + err.Error())
		}
	}()
	return nil
}

// SendCommand writes a line to the server's stdin.
func (m *Manager) SendCommand(id, line string) error {
	s, err := m.server(id)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.hijack == nil || (s.state != panelv1.ServerState_SERVER_STATE_RUNNING && s.state != panelv1.ServerState_SERVER_STATE_STARTING) {
		return tunnel.Conflict("server is not running")
	}
	line = strings.TrimRight(line, "\r\n")
	_, err = s.hijack.Conn.Write([]byte(line + "\n"))
	return err
}

// Console returns the console of a server for streaming.
func (m *Manager) Console(id string) (*Console, error) {
	s, err := m.server(id)
	if err != nil {
		return nil, err
	}
	return s.console, nil
}

// ---------------------------------------------------------------------------
// Install
// ---------------------------------------------------------------------------

// Install runs the template's install script in a one-off container.
func (m *Manager) Install(spec *panelv1.ServerSpec, inst *panelv1.InstallSpec) error {
	if spec == nil || inst == nil || inst.Image == "" {
		return tunnel.BadRequest("spec and install image required")
	}
	s, err := m.server(spec.Id)
	if err != nil {
		return err
	}
	s.mu.Lock()
	if s.state != panelv1.ServerState_SERVER_STATE_OFFLINE {
		st := s.state
		s.mu.Unlock()
		return tunnel.Conflict("server must be offline to install (" + st.String() + ")")
	}
	s.spec = spec
	s.setStateLocked(panelv1.ServerState_SERVER_STATE_INSTALLING, false)
	s.mu.Unlock()

	go s.install(spec, inst)
	return nil
}

func (s *Server) install(spec *panelv1.ServerSpec, inst *panelv1.InstallSpec) {
	m := s.m
	ctx := context.Background()
	tail := &tailBuffer{max: 8 << 10}
	out := io.MultiWriter(s.console, tail)

	success := false
	defer func() {
		s.setState(panelv1.ServerState_SERVER_STATE_OFFLINE, false)
		m.emitEvent(&panelv1.Event{Kind: &panelv1.Event_InstallFinished{InstallFinished: &panelv1.InstallFinished{
			ServerId: s.id, Success: success, LogTail: tail.String(),
		}}})
	}()
	fail := func(err error) {
		s.console.System("Installation failed: " + err.Error())
		m.log.Warn("install failed", "server", s.id, "err", err)
	}

	s.console.System("Installing server")
	dir, idir := m.serverDir(s.id), m.installDir(s.id)
	for _, d := range []string{dir, idir} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			fail(err)
			return
		}
	}
	defer os.RemoveAll(idir)
	script := strings.ReplaceAll(inst.Script, "\r\n", "\n")
	if err := os.WriteFile(filepath.Join(idir, "install.sh"), []byte(script), 0o755); err != nil {
		fail(err)
		return
	}
	if err := m.ensureImage(ctx, inst.Image, s.console); err != nil {
		fail(err)
		return
	}

	name := installContainerName(s.id)
	_ = m.docker.ContainerRemove(ctx, name, container.RemoveOptions{Force: true})
	entrypoint := inst.Entrypoint
	if entrypoint == "" {
		entrypoint = "bash"
	}
	env := envList(spec)
	memory := int64(spec.MemoryMb) << 20
	if memory < 1<<30 {
		memory = 1 << 30 // installers (e.g. jar downloads) need some headroom
	}
	_, err := m.docker.ContainerCreate(ctx, &container.Config{
		Image:        inst.Image,
		Cmd:          []string{entrypoint, "/mnt/install/install.sh"},
		Env:          env,
		User:         "0",
		AttachStdout: true,
		AttachStderr: true,
		Labels:       map[string]string{labelManaged: "true", labelInstall: s.id},
	}, &container.HostConfig{
		Mounts: []mount.Mount{
			{Type: mount.TypeBind, Source: dir, Target: "/mnt/server"},
			{Type: mount.TypeBind, Source: idir, Target: "/mnt/install", ReadOnly: true},
		},
		Resources: container.Resources{Memory: memory, MemorySwap: memory, PidsLimit: ptr(int64(512))},
	}, nil, nil, name)
	if err != nil {
		fail(fmt.Errorf("create install container: %w", err))
		return
	}
	defer func() { _ = m.docker.ContainerRemove(context.Background(), name, container.RemoveOptions{Force: true}) }()

	hijack, err := m.docker.ContainerAttach(ctx, name, container.AttachOptions{Stream: true, Stdout: true, Stderr: true})
	if err != nil {
		fail(fmt.Errorf("attach: %w", err))
		return
	}
	defer hijack.Close()
	copied := make(chan struct{})
	go func() {
		_, _ = stdcopy.StdCopy(newCRLFWriter(out), newCRLFWriter(out), hijack.Reader)
		close(copied)
	}()

	if err := m.docker.ContainerStart(ctx, name, container.StartOptions{}); err != nil {
		fail(fmt.Errorf("start install container: %w", err))
		return
	}
	statusCh, errCh := m.docker.ContainerWait(ctx, name, container.WaitConditionNotRunning)
	var code int64 = -1
	select {
	case st := <-statusCh:
		code = st.StatusCode
	case err := <-errCh:
		fail(err)
		return
	}
	select {
	case <-copied:
	case <-time.After(2 * time.Second):
	}

	m.chown(dir, true)
	if code != 0 {
		fail(fmt.Errorf("install script exited with code %d", code))
		return
	}
	success = true
	s.console.System("Installation completed")
}

// ---------------------------------------------------------------------------
// Delete / states / recovery
// ---------------------------------------------------------------------------

// Delete removes the server's containers and optionally its files.
func (m *Manager) Delete(id string, deleteFiles bool) error {
	s, err := m.server(id)
	if err != nil {
		return err
	}
	ctx := context.Background()
	s.mu.Lock()
	s.stopRequested = true
	s.mu.Unlock()
	for _, name := range []string{containerName(id), installContainerName(id)} {
		if err := m.docker.ContainerRemove(ctx, name, container.RemoveOptions{Force: true}); err != nil && !client.IsErrNotFound(err) {
			return fmt.Errorf("remove container: %w", err)
		}
	}
	if deleteFiles {
		if err := os.RemoveAll(m.serverDir(id)); err != nil {
			return fmt.Errorf("remove files: %w", err)
		}
	}
	_ = os.Remove(m.specFile(id))
	m.mu.Lock()
	delete(m.servers, id)
	m.mu.Unlock()
	return nil
}

// States reports server states; empty ids means all known servers.
func (m *Manager) States(ids []string) map[string]panelv1.ServerState {
	out := map[string]panelv1.ServerState{}
	if len(ids) == 0 {
		m.mu.Lock()
		for id, s := range m.servers {
			out[id] = s.State()
		}
		m.mu.Unlock()
		return out
	}
	for _, id := range ids {
		s, err := m.server(id)
		if err != nil {
			continue
		}
		out[id] = s.State()
	}
	return out
}

// Recover re-attaches to containers that kept running while the daemon was
// down and cleans up interrupted installs.
func (m *Manager) Recover(ctx context.Context) error {
	list, err := m.docker.ContainerList(ctx, container.ListOptions{
		All:     true,
		Filters: filters.NewArgs(filters.Arg("label", labelManaged+"=true")),
	})
	if err != nil {
		return err
	}
	for _, c := range list {
		if id := c.Labels[labelInstall]; id != "" {
			_ = m.docker.ContainerRemove(ctx, c.ID, container.RemoveOptions{Force: true})
			m.log.Info("removed interrupted install container", "server", id)
			continue
		}
		id := c.Labels[labelServer]
		if id == "" || c.State != "running" {
			continue
		}
		s, err := m.server(id)
		if err != nil {
			continue
		}
		hijack, err := m.docker.ContainerAttach(ctx, c.ID, container.AttachOptions{
			Stream: true, Stdin: true, Stdout: true, Stderr: true,
		})
		if err != nil {
			m.log.Warn("re-attach failed", "server", id, "err", err)
			continue
		}
		exited := make(chan struct{})
		s.mu.Lock()
		s.spec = m.loadSpec(id)
		s.hijack = &hijack
		s.exited = exited
		s.startedAt = time.Unix(c.Created, 0)
		s.state = panelv1.ServerState_SERVER_STATE_RUNNING
		s.mu.Unlock()
		s.console.System("Daemon restarted, re-attached to running server")
		go s.pump(hijack.Reader, nil)
		go s.waitExit(containerName(id), exited)
		m.log.Info("re-attached to running server", "server", id)
	}
	return nil
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

func (m *Manager) containerConfig(spec *panelv1.ServerSpec, dir string) (*container.Config, *container.HostConfig) {
	exposed := nat.PortSet{}
	bindings := nat.PortMap{}
	for _, p := range spec.Ports {
		for _, proto := range []string{"tcp", "udp"} {
			port := nat.Port(fmt.Sprintf("%d/%s", p.Port, proto))
			exposed[port] = struct{}{}
			bindings[port] = append(bindings[port], nat.PortBinding{HostIP: p.Ip, HostPort: strconv.Itoa(int(p.Port))})
		}
	}
	res := container.Resources{PidsLimit: ptr(int64(512))}
	if spec.MemoryMb > 0 {
		res.Memory = int64(spec.MemoryMb) << 20
		res.MemorySwap = res.Memory
	}
	if spec.CpuPercent > 0 {
		res.NanoCPUs = int64(spec.CpuPercent) * 10_000_000
	}
	return &container.Config{
		Image:        spec.Image,
		Env:          envList(spec),
		Tty:          true,
		OpenStdin:    true,
		AttachStdin:  true,
		AttachStdout: true,
		AttachStderr: true,
		User:         m.opts.ContainerUser,
		WorkingDir:   "/home/container",
		ExposedPorts: exposed,
		Labels:       map[string]string{labelManaged: "true", labelServer: spec.Id},
	}, &container.HostConfig{
		Mounts:       []mount.Mount{{Type: mount.TypeBind, Source: dir, Target: "/home/container"}},
		PortBindings: bindings,
		Resources:    res,
		SecurityOpt:  []string{"no-new-privileges"},
		CapDrop:      []string{"setpcap", "mknod", "audit_write", "net_raw", "dac_override", "fowner", "fsetid", "net_bind_service", "sys_chroot", "setfcap"},
	}
}

// envList builds the container environment. The panel supplies template
// variables plus SERVER_MEMORY/SERVER_IP/SERVER_PORT; STARTUP is evaluated
// by Pterodactyl-compatible image entrypoints ("yolks").
func envList(spec *panelv1.ServerSpec) []string {
	env := make([]string, 0, len(spec.Env)+2)
	for _, k := range sortedKeys(spec.Env) {
		env = append(env, k+"="+spec.Env[k])
	}
	env = append(env, "STARTUP="+spec.Startup, "P_SERVER_UUID="+spec.Id)
	return env
}

func (m *Manager) ensureImage(ctx context.Context, ref string, console *Console) error {
	if _, err := m.docker.ImageInspect(ctx, ref); err == nil {
		return nil
	} else if !client.IsErrNotFound(err) {
		return fmt.Errorf("inspect image: %w", err)
	}
	console.System("Pulling image " + ref)
	rc, err := m.docker.ImagePull(ctx, ref, image.PullOptions{})
	if err != nil {
		return fmt.Errorf("pull image: %w", err)
	}
	defer rc.Close()
	dec := json.NewDecoder(bufio.NewReader(rc))
	for {
		var msg struct {
			Error string `json:"error"`
		}
		if err := dec.Decode(&msg); err != nil {
			if errors.Is(err, io.EOF) {
				break
			}
			return fmt.Errorf("pull image: %w", err)
		}
		if msg.Error != "" {
			return fmt.Errorf("pull image: %s", msg.Error)
		}
	}
	console.System("Image pulled")
	return nil
}

func (m *Manager) saveSpec(spec *panelv1.ServerSpec) {
	data, err := protojson.Marshal(spec)
	if err == nil {
		err = os.WriteFile(m.specFile(spec.Id), data, 0o600)
	}
	if err != nil {
		m.log.Warn("save spec failed", "server", spec.Id, "err", err)
	}
}

func (m *Manager) loadSpec(id string) *panelv1.ServerSpec {
	data, err := os.ReadFile(m.specFile(id))
	if err != nil {
		return nil
	}
	spec := &panelv1.ServerSpec{}
	if protojson.Unmarshal(data, spec) != nil {
		return nil
	}
	return spec
}

// chown gives the container user ownership of server files (Linux only;
// Docker Desktop maps ownership itself).
func (m *Manager) chown(dir string, recursive bool) {
	if runtime.GOOS != "linux" || m.opts.ContainerUser == "" {
		return
	}
	uidStr, gidStr, _ := strings.Cut(m.opts.ContainerUser, ":")
	uid, err1 := strconv.Atoi(uidStr)
	gid, err2 := strconv.Atoi(gidStr)
	if err1 != nil || err2 != nil {
		return
	}
	if !recursive {
		_ = os.Lchown(dir, uid, gid)
		return
	}
	_ = filepath.WalkDir(dir, func(p string, _ fs.DirEntry, err error) error {
		if err == nil {
			_ = os.Lchown(p, uid, gid)
		}
		return nil
	})
}

func ptr[T any](v T) *T { return &v }

// tailBuffer keeps the last max bytes written.
type tailBuffer struct {
	mu  sync.Mutex
	max int
	buf []byte
}

func (t *tailBuffer) Write(p []byte) (int, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.buf = append(t.buf, p...)
	if over := len(t.buf) - t.max; over > 0 {
		t.buf = append([]byte(nil), t.buf[over:]...)
	}
	return len(p), nil
}

func (t *tailBuffer) String() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return string(t.buf)
}

// crlfWriter turns \n into \r\n so non-TTY output renders in xterm.
type crlfWriter struct{ w io.Writer }

func newCRLFWriter(w io.Writer) io.Writer { return crlfWriter{w} }

func (c crlfWriter) Write(p []byte) (int, error) {
	out := strings.ReplaceAll(strings.ReplaceAll(string(p), "\r\n", "\n"), "\n", "\r\n")
	if _, err := c.w.Write([]byte(out)); err != nil {
		return 0, err
	}
	return len(p), nil
}
