package servers

import (
	"archive/tar"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"hash"
	"io"
	"io/fs"
	"path"
	"strings"

	"github.com/klauspost/compress/zstd"

	"panel/daemon/internal/backup"
	panelv1 "panel/daemon/internal/pb/panel/v1"
	"panel/daemon/internal/tunnel"
)

// BackupDir is the node directory used by "local" backup targets.
func (m *Manager) BackupDir() string { return m.opts.BackupDir }

// CreateBackup starts a backup in the background. Running servers are
// backed up live (like Wings); files that change mid-read are clamped or
// zero-padded to the size recorded in the tar header.
func (m *Manager) CreateBackup(req *panelv1.BackupCreateRequest) error {
	s, err := m.server(req.ServerId)
	if err != nil {
		return err
	}
	if err := backup.ValidKey(req.Key); err != nil {
		return err
	}
	store, err := backup.Open(context.Background(), req.Target, m.opts.BackupDir)
	if err != nil {
		return err
	}
	s.mu.Lock()
	if s.restoring || s.backingUp {
		s.mu.Unlock()
		store.Close()
		return tunnel.Conflict("another backup operation is running for this server")
	}
	s.backingUp = true
	s.mu.Unlock()

	go func() {
		defer store.Close()
		size, sum, err := m.writeBackup(context.Background(), req.ServerId, req.Ignore, func(r io.Reader) error {
			return store.Put(context.Background(), req.Key, r)
		})
		s.mu.Lock()
		s.backingUp = false
		s.mu.Unlock()
		evt := &panelv1.BackupFinished{ServerId: req.ServerId, BackupId: req.BackupId, Success: err == nil, SizeBytes: size, Sha256: sum}
		if err != nil {
			m.log.Warn("backup failed", "server", req.ServerId, "backup", req.BackupId, "err", err)
			evt.Error = err.Error()
		}
		m.emitEvent(&panelv1.Event{Kind: &panelv1.Event_BackupFinished{BackupFinished: evt}})
	}()
	return nil
}

// countingHash tracks size and sha256 of what passes through it.
type countingHash struct {
	h hash.Hash
	n uint64
}

func (c *countingHash) Write(p []byte) (int, error) {
	c.n += uint64(len(p))
	return c.h.Write(p)
}

// writeBackup produces tar+zstd of the server root and hands the stream to
// put. It returns the archive size and sha256.
func (m *Manager) writeBackup(ctx context.Context, id string, ignore []string, put func(io.Reader) error) (uint64, string, error) {
	root, err := m.OpenRoot(id)
	if err != nil {
		return 0, "", err
	}
	defer root.Close()
	match := newIgnoreMatcher(ignore)

	pr, pw := io.Pipe()
	sum := &countingHash{h: sha256.New()}
	putErr := make(chan error, 1)
	go func() {
		err := put(io.TeeReader(pr, sum))
		pr.CloseWithError(err) // unblocks the writer if put gave up early
		putErr <- err
	}()

	writeErr := func() error {
		zw, err := zstd.NewWriter(pw, zstd.WithEncoderLevel(zstd.SpeedDefault), zstd.WithEncoderConcurrency(2))
		if err != nil {
			return err
		}
		tw := tar.NewWriter(zw)
		fsys := root.FS()
		err = fs.WalkDir(fsys, ".", func(p string, d fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if ctx.Err() != nil {
				return ctx.Err()
			}
			if p == "." {
				return nil
			}
			if match(p, d.IsDir()) {
				if d.IsDir() {
					return fs.SkipDir
				}
				return nil
			}
			info, err := d.Info()
			if err != nil {
				if errors.Is(err, fs.ErrNotExist) {
					return nil // deleted while walking
				}
				return err
			}
			if !(info.IsDir() || info.Mode().IsRegular()) {
				return nil // symlinks, sockets, devices
			}
			hdr, err := tar.FileInfoHeader(info, "")
			if err != nil {
				return err
			}
			hdr.Name = p
			if info.IsDir() {
				hdr.Name += "/"
			}
			hdr.Uname, hdr.Gname = "", ""
			if err := tw.WriteHeader(hdr); err != nil {
				return err
			}
			if !info.Mode().IsRegular() {
				return nil
			}
			f, err := fsys.Open(p)
			if err != nil {
				return err
			}
			defer f.Close()
			n, err := io.CopyN(tw, f, hdr.Size)
			if err != nil && !errors.Is(err, io.EOF) {
				return err
			}
			if n < hdr.Size { // file shrank while reading
				_, err = io.CopyN(tw, zeroReader{}, hdr.Size-n)
			}
			return err
		})
		if err != nil {
			return err
		}
		if err := tw.Close(); err != nil {
			return err
		}
		return zw.Close()
	}()
	pw.CloseWithError(writeErr)
	perr := <-putErr
	if writeErr != nil {
		return 0, "", fmt.Errorf("archive: %w", writeErr)
	}
	if perr != nil {
		return 0, "", fmt.Errorf("upload: %w", perr)
	}
	return sum.n, hex.EncodeToString(sum.h.Sum(nil)), nil
}

type zeroReader struct{}

func (zeroReader) Read(p []byte) (int, error) {
	clear(p)
	return len(p), nil
}

// RestoreBackup extracts a backup in the background. The server must be
// offline and cannot be started until the restore finished.
func (m *Manager) RestoreBackup(req *panelv1.BackupRestoreRequest) error {
	s, err := m.server(req.ServerId)
	if err != nil {
		return err
	}
	if err := backup.ValidKey(req.Key); err != nil {
		return err
	}
	store, err := backup.Open(context.Background(), req.Target, m.opts.BackupDir)
	if err != nil {
		return err
	}
	s.mu.Lock()
	if s.state != panelv1.ServerState_SERVER_STATE_OFFLINE || s.restoring || s.backingUp {
		s.mu.Unlock()
		store.Close()
		return tunnel.Conflict("server must be offline and idle to restore a backup")
	}
	s.restoring = true
	s.mu.Unlock()

	go func() {
		defer store.Close()
		err := m.restore(context.Background(), req, store)
		s.mu.Lock()
		s.restoring = false
		s.mu.Unlock()
		evt := &panelv1.BackupFinished{ServerId: req.ServerId, BackupId: req.BackupId, Restore: true, Success: err == nil}
		if err != nil {
			m.log.Warn("restore failed", "server", req.ServerId, "backup", req.BackupId, "err", err)
			evt.Error = err.Error()
			s.console.System("Backup restore failed: " + err.Error())
		} else {
			s.console.System("Backup restored")
		}
		m.emitEvent(&panelv1.Event{Kind: &panelv1.Event_BackupFinished{BackupFinished: evt}})
	}()
	return nil
}

func (m *Manager) restore(ctx context.Context, req *panelv1.BackupRestoreRequest, store backup.Store) error {
	rc, err := store.Get(ctx, req.Key)
	if err != nil {
		return err
	}
	defer rc.Close()
	root, err := m.OpenRoot(req.ServerId)
	if err != nil {
		return err
	}
	defer root.Close()
	defer m.invalidateDisk(req.ServerId)
	defer m.chown(m.serverDir(req.ServerId), true)

	if req.Truncate {
		entries, err := fs.ReadDir(root.FS(), ".")
		if err != nil {
			return err
		}
		for _, e := range entries {
			if err := root.RemoveAll(e.Name()); err != nil {
				return mapFSErr(err)
			}
		}
		m.invalidateDisk(req.ServerId)
	}

	budget := uint64(unlimitedExtractBudget)
	if req.DiskLimitBytes > 0 {
		used := m.DiskUsage(req.ServerId)
		if used >= req.DiskLimitBytes {
			return &tunnel.Error{Code: 507, Message: "disk limit reached"}
		}
		budget = req.DiskLimitBytes - used
	}
	ex := &extractor{root: root, base: ".", budget: budget, maxEntries: maxBackupEntries}

	h := sha256.New()
	zr, err := zstd.NewReader(io.TeeReader(rc, h), zstd.WithDecoderConcurrency(2), zstd.WithDecoderMaxMemory(1<<30))
	if err != nil {
		return err
	}
	defer zr.Close()
	tr := tar.NewReader(zr)
	for {
		hdr, err := tr.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return fmt.Errorf("invalid backup archive: %w", err)
		}
		if err := ex.entry(hdr.Name, hdr.FileInfo(), func() (io.ReadCloser, error) { return io.NopCloser(tr), nil }); err != nil {
			return err
		}
	}
	// Drain the rest so the checksum covers the whole object.
	if _, err := io.Copy(io.Discard, rc); err != nil {
		return err
	}
	_, _ = io.Copy(io.Discard, zr)
	if req.Sha256 != "" && !strings.EqualFold(req.Sha256, hex.EncodeToString(h.Sum(nil))) {
		return errors.New("checksum mismatch: archive is corrupt or was modified")
	}
	return nil
}

// newIgnoreMatcher understands a gitignore subset: "name" matches at any
// depth, "/name" only at the root, a trailing "/" only directories, and
// shell globs via path.Match. Blank lines and "#" comments are skipped.
func newIgnoreMatcher(patterns []string) func(p string, dir bool) bool {
	type rule struct {
		pat      string
		anchored bool
		dirOnly  bool
	}
	var rules []rule
	for _, raw := range patterns {
		p := strings.TrimSpace(raw)
		if p == "" || strings.HasPrefix(p, "#") || strings.HasPrefix(p, "!") {
			continue
		}
		r := rule{}
		if strings.HasSuffix(p, "/") {
			r.dirOnly = true
			p = strings.TrimSuffix(p, "/")
		}
		if strings.HasPrefix(p, "/") {
			r.anchored = true
			p = strings.TrimPrefix(p, "/")
		} else if strings.Contains(p, "/") {
			r.anchored = true
		}
		if p == "" {
			continue
		}
		r.pat = p
		rules = append(rules, r)
	}
	return func(p string, dir bool) bool {
		for _, r := range rules {
			if r.dirOnly && !dir {
				continue
			}
			if r.anchored {
				if ok, _ := path.Match(r.pat, p); ok {
					return true
				}
				continue
			}
			if ok, _ := path.Match(r.pat, path.Base(p)); ok {
				return true
			}
		}
		return false
	}
}
