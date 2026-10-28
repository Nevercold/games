package servers

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"path"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/image"
	"github.com/docker/docker/api/types/mount"
	"github.com/docker/docker/client"
	"github.com/docker/docker/pkg/stdcopy"

	panelv1 "panel/daemon/internal/pb/panel/v1"
	"panel/daemon/internal/tunnel"
)

const helperImage = "alpine:3.20"

var (
	validVolume    = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,254}$`)
	validContainer = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$`)
)

// guardUnmanaged refuses actions on containers the panel owns: those are
// controlled through the server page so state and permissions stay in sync.
func (m *Manager) guardUnmanaged(ctx context.Context, id string) error {
	if !validContainer.MatchString(id) {
		return tunnel.BadRequest("invalid container id")
	}
	info, err := m.docker.ContainerInspect(ctx, id)
	if err != nil {
		if client.IsErrNotFound(err) {
			return tunnel.NotFound("container not found")
		}
		return err
	}
	if info.Config != nil && info.Config.Labels[labelManaged] == "true" {
		return tunnel.Conflict("container is managed by the panel, use the server page")
	}
	return nil
}

// ContainerAction starts, stops, restarts, kills or removes an unmanaged container.
func (m *Manager) ContainerAction(ctx context.Context, id, action string) error {
	if err := m.guardUnmanaged(ctx, id); err != nil {
		return err
	}
	timeout := 30
	switch action {
	case "start":
		return m.docker.ContainerStart(ctx, id, container.StartOptions{})
	case "stop":
		return m.docker.ContainerStop(ctx, id, container.StopOptions{Timeout: &timeout})
	case "restart":
		return m.docker.ContainerRestart(ctx, id, container.StopOptions{Timeout: &timeout})
	case "kill":
		return m.docker.ContainerKill(ctx, id, "SIGKILL")
	case "remove":
		return m.docker.ContainerRemove(ctx, id, container.RemoveOptions{Force: true})
	}
	return tunnel.BadRequest("unknown action")
}

var validImageRef = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._/:@-]{0,254}$`)

// PullImage pulls an image and waits for completion.
func (m *Manager) PullImage(ctx context.Context, ref string) error {
	if !validImageRef.MatchString(ref) {
		return tunnel.BadRequest("invalid image reference")
	}
	rc, err := m.docker.ImagePull(ctx, ref, image.PullOptions{})
	if err != nil {
		return tunnel.BadRequest("pull failed: " + err.Error())
	}
	defer rc.Close()
	dec := json.NewDecoder(bufio.NewReader(rc))
	for {
		var msg struct {
			Error string `json:"error"`
		}
		if err := dec.Decode(&msg); err != nil {
			if errors.Is(err, io.EOF) {
				return nil
			}
			return err
		}
		if msg.Error != "" {
			return tunnel.BadRequest("pull failed: " + msg.Error)
		}
	}
}

// RemoveImage deletes an image. Images used by panel servers can only be
// removed with force, which Docker itself refuses while containers run.
func (m *Manager) RemoveImage(ctx context.Context, id string, force bool) error {
	if !validImageRef.MatchString(id) {
		return tunnel.BadRequest("invalid image id")
	}
	_, err := m.docker.ImageRemove(ctx, id, image.RemoveOptions{Force: force, PruneChildren: true})
	if err != nil {
		if client.IsErrNotFound(err) {
			return tunnel.NotFound("image not found")
		}
		return tunnel.Conflict(err.Error())
	}
	return nil
}

// Exec runs an interactive command in a container and bridges it to the
// stream. Panel frames: 0x00+stdin bytes, 0x01+JSON resize.
func (m *Manager) Exec(ctx context.Context, open *panelv1.ExecOpen, in <-chan []byte, send func([]byte) error) error {
	if !validContainer.MatchString(open.ContainerId) {
		return tunnel.BadRequest("invalid container id")
	}
	cmd := open.Cmd
	if len(cmd) == 0 {
		cmd = []string{"sh"}
	}
	exec, err := m.docker.ContainerExecCreate(ctx, open.ContainerId, container.ExecOptions{
		Cmd: cmd, Tty: true, AttachStdin: true, AttachStdout: true, AttachStderr: true,
		ConsoleSize: &[2]uint{uint(max(open.Rows, 10)), uint(max(open.Cols, 40))},
	})
	if err != nil {
		if client.IsErrNotFound(err) {
			return tunnel.NotFound("container not found")
		}
		return tunnel.Conflict("exec failed: " + err.Error())
	}
	hijack, err := m.docker.ContainerExecAttach(ctx, exec.ID, container.ExecAttachOptions{Tty: true})
	if err != nil {
		return err
	}
	defer hijack.Close()

	outDone := make(chan error, 1)
	go func() {
		buf := make([]byte, 32<<10)
		for {
			n, err := hijack.Reader.Read(buf)
			if n > 0 {
				if serr := send(append([]byte(nil), buf[:n]...)); serr != nil {
					outDone <- serr
					return
				}
			}
			if err != nil {
				outDone <- nil
				return
			}
		}
	}()

	for {
		select {
		case <-ctx.Done():
			return nil
		case err := <-outDone:
			return err
		case frame, ok := <-in:
			if !ok {
				in = nil
				continue
			}
			if len(frame) == 0 {
				continue
			}
			switch frame[0] {
			case 0:
				if _, err := hijack.Conn.Write(frame[1:]); err != nil {
					return nil
				}
			case 1:
				var size struct{ Cols, Rows uint }
				if json.Unmarshal(frame[1:], &size) == nil && size.Cols > 0 && size.Rows > 0 {
					_ = m.docker.ContainerExecResize(ctx, exec.ID, container.ResizeOptions{Width: size.Cols, Height: size.Rows})
				}
			}
		}
	}
}

// ---------------------------------------------------------------------------
// Volume browser (read-only)
// ---------------------------------------------------------------------------

// runHelper mounts a volume read-only into a short-lived alpine container,
// runs cmd (no shell, arguments are passed verbatim) and returns stdout.
func (m *Manager) runHelper(ctx context.Context, volume string, cmd []string, maxOut int64) ([]byte, error) {
	if !validVolume.MatchString(volume) {
		return nil, tunnel.BadRequest("invalid volume name")
	}
	if err := m.ensureImage(ctx, helperImage, newConsole()); err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	created, err := m.docker.ContainerCreate(ctx, &container.Config{
		Image:  helperImage,
		Cmd:    cmd,
		User:   "0",
		Labels: map[string]string{labelManaged: "true", "panel.helper": "volume"},
	}, &container.HostConfig{
		Mounts:         []mount.Mount{{Type: mount.TypeVolume, Source: volume, Target: "/v", ReadOnly: true}},
		NetworkMode:    "none",
		ReadonlyRootfs: true,
		Resources:      container.Resources{Memory: 64 << 20, PidsLimit: ptr(int64(32))},
		CapDrop:        []string{"ALL"},
	}, nil, nil, "")
	if err != nil {
		return nil, err
	}
	defer func() {
		_ = m.docker.ContainerRemove(context.Background(), created.ID, container.RemoveOptions{Force: true})
	}()
	if err := m.docker.ContainerStart(ctx, created.ID, container.StartOptions{}); err != nil {
		return nil, err
	}
	statusCh, errCh := m.docker.ContainerWait(ctx, created.ID, container.WaitConditionNotRunning)
	var code int64
	select {
	case st := <-statusCh:
		code = st.StatusCode
	case err := <-errCh:
		return nil, err
	}
	rc, err := m.docker.ContainerLogs(ctx, created.ID, container.LogsOptions{ShowStdout: true, ShowStderr: true})
	if err != nil {
		return nil, err
	}
	defer rc.Close()
	var stdout, stderr bytes.Buffer
	if _, err := stdcopy.StdCopy(&stdout, &stderr, io.LimitReader(rc, maxOut+8192)); err != nil {
		return nil, err
	}
	if code != 0 {
		msg := strings.TrimSpace(stderr.String())
		if strings.Contains(msg, "No such file") {
			return nil, tunnel.NotFound("path not found")
		}
		return nil, tunnel.BadRequest(fmt.Sprintf("helper failed: %s", msg))
	}
	return stdout.Bytes(), nil
}

func volumePath(p string) string {
	return path.Join("/v", CleanPath(p))
}

// ListVolume lists a directory inside a volume.
func (m *Manager) ListVolume(ctx context.Context, volume, rel string) ([]*panelv1.FileEntry, error) {
	// busybox find + stat; %F gives the file type, names come last so they
	// may contain the separator.
	out, err := m.runHelper(ctx, volume, []string{
		"find", volumePath(rel), "-mindepth", "1", "-maxdepth", "1",
		"-exec", "stat", "-c", "%s|%a|%Y|%F|%n", "{}", "+",
	}, 4<<20)
	if err != nil {
		return nil, err
	}
	var entries []*panelv1.FileEntry
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		parts := strings.SplitN(line, "|", 5)
		if len(parts) != 5 {
			continue
		}
		size, _ := strconv.ParseUint(parts[0], 10, 64)
		mode, _ := strconv.ParseUint(parts[1], 8, 32)
		mtime, _ := strconv.ParseInt(parts[2], 10, 64)
		entries = append(entries, &panelv1.FileEntry{
			Name:         path.Base(parts[4]),
			Size:         size,
			Mode:         uint32(mode),
			ModifiedUnix: mtime,
			IsDir:        parts[3] == "directory",
			IsSymlink:    parts[3] == "symbolic link",
		})
	}
	return entries, nil
}

// ReadVolumeFile returns the first maxBytes of a file inside a volume.
func (m *Manager) ReadVolumeFile(ctx context.Context, volume, rel string, maxBytes uint64) ([]byte, bool, error) {
	if maxBytes == 0 || maxBytes > 4<<20 {
		maxBytes = 1 << 20
	}
	out, err := m.runHelper(ctx, volume, []string{"head", "-c", strconv.FormatUint(maxBytes+1, 10), volumePath(rel)}, int64(maxBytes)+1)
	if err != nil {
		return nil, false, err
	}
	truncated := uint64(len(out)) > maxBytes
	if truncated {
		out = out[:maxBytes]
	}
	return out, truncated, nil
}
