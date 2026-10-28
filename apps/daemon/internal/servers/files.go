package servers

import (
	"archive/tar"
	"archive/zip"
	"compress/gzip"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"io"
	"io/fs"
	"os"
	"path"
	"sort"
	"strings"
	"time"

	panelv1 "panel/daemon/internal/pb/panel/v1"
	"panel/daemon/internal/tunnel"
)

const (
	maxArchiveEntries      = 100_000
	unlimitedExtractBudget = 50 << 30 // 50 GiB cap when the server has no disk limit
	transferChunk          = 256 << 10
)

// CleanPath turns a client path into a root-relative path ("." for the root).
// os.Root still enforces containment; this only normalises input.
func CleanPath(p string) string {
	c := strings.TrimPrefix(path.Clean("/"+strings.ReplaceAll(p, "\\", "/")), "/")
	if c == "" {
		return "."
	}
	return c
}

// OpenRoot opens the server directory as an os.Root.
func (m *Manager) OpenRoot(id string) (*os.Root, error) {
	if !validID.MatchString(id) {
		return nil, tunnel.BadRequest("invalid server id")
	}
	dir := m.serverDir(id)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	return os.OpenRoot(dir)
}

// DiskUsage returns the cached directory size (refreshed at most every 30s).
func (m *Manager) DiskUsage(id string) uint64 {
	s, err := m.server(id)
	if err != nil {
		return 0
	}
	return s.disk()
}

// InvalidateDisk forces the next DiskUsage call to recompute (after writes).
func (m *Manager) InvalidateDisk(id string) { m.invalidateDisk(id) }

func (m *Manager) invalidateDisk(id string) {
	if s, err := m.server(id); err == nil {
		s.diskMu.Lock()
		s.diskAt = time.Time{}
		s.diskMu.Unlock()
	}
}

// CheckQuota fails when adding `extra` bytes would exceed `limit` (0 = none).
func (m *Manager) CheckQuota(id string, limit, extra uint64) error {
	if limit == 0 {
		return nil
	}
	if m.DiskUsage(id)+extra > limit {
		return &tunnel.Error{Code: 507, Message: "disk limit reached"}
	}
	return nil
}

func mapFSErr(err error) error {
	switch {
	case err == nil:
		return nil
	case errors.Is(err, fs.ErrNotExist):
		return tunnel.NotFound("file not found")
	case errors.Is(err, fs.ErrExist):
		return tunnel.Conflict("file already exists")
	case errors.Is(err, fs.ErrPermission):
		return &tunnel.Error{Code: 403, Message: "permission denied"}
	case strings.Contains(err.Error(), "path escapes"):
		return tunnel.BadRequest("path escapes server directory")
	}
	return err
}

// ListFiles lists a directory, directories first.
func (m *Manager) ListFiles(id, rel string) ([]*panelv1.FileEntry, error) {
	root, err := m.OpenRoot(id)
	if err != nil {
		return nil, err
	}
	defer root.Close()
	dir, err := root.Open(CleanPath(rel))
	if err != nil {
		return nil, mapFSErr(err)
	}
	defer dir.Close()
	items, err := dir.ReadDir(-1)
	if err != nil {
		return nil, mapFSErr(err)
	}
	out := make([]*panelv1.FileEntry, 0, len(items))
	for _, it := range items {
		info, err := it.Info()
		if err != nil {
			continue
		}
		out = append(out, &panelv1.FileEntry{
			Name:         it.Name(),
			Size:         uint64(max(info.Size(), 0)),
			Mode:         uint32(info.Mode().Perm()),
			ModifiedUnix: info.ModTime().Unix(),
			IsDir:        it.IsDir(),
			IsSymlink:    info.Mode()&fs.ModeSymlink != 0,
		})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].IsDir != out[j].IsDir {
			return out[i].IsDir
		}
		return strings.ToLower(out[i].Name) < strings.ToLower(out[j].Name)
	})
	return out, nil
}

// ReadFile returns up to maxBytes of a regular file.
func (m *Manager) ReadFile(id, rel string, maxBytes uint64) ([]byte, uint64, bool, error) {
	root, err := m.OpenRoot(id)
	if err != nil {
		return nil, 0, false, err
	}
	defer root.Close()
	f, err := root.Open(CleanPath(rel))
	if err != nil {
		return nil, 0, false, mapFSErr(err)
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return nil, 0, false, mapFSErr(err)
	}
	if !info.Mode().IsRegular() {
		return nil, 0, false, tunnel.BadRequest("not a regular file")
	}
	if maxBytes == 0 || maxBytes > 16<<20 {
		maxBytes = 16 << 20
	}
	data, err := io.ReadAll(io.LimitReader(f, int64(maxBytes)))
	if err != nil {
		return nil, 0, false, err
	}
	size := uint64(info.Size())
	return data, size, size > uint64(len(data)), nil
}

// WriteFile replaces a file atomically (temp file + rename).
func (m *Manager) WriteFile(id, rel string, content []byte, limit uint64) error {
	name := CleanPath(rel)
	if name == "." {
		return tunnel.BadRequest("path required")
	}
	if err := m.CheckQuota(id, limit, uint64(len(content))); err != nil {
		return err
	}
	root, err := m.OpenRoot(id)
	if err != nil {
		return err
	}
	defer root.Close()
	defer m.invalidateDisk(id)
	if dir := path.Dir(name); dir != "." {
		if err := root.MkdirAll(dir, 0o755); err != nil {
			return mapFSErr(err)
		}
	}
	tmp := tempName(name)
	if err := root.WriteFile(tmp, content, 0o644); err != nil {
		return mapFSErr(err)
	}
	if err := root.Rename(tmp, name); err != nil {
		_ = root.Remove(tmp)
		return mapFSErr(err)
	}
	return nil
}

func (m *Manager) Mkdir(id, rel string) error {
	root, err := m.OpenRoot(id)
	if err != nil {
		return err
	}
	defer root.Close()
	return mapFSErr(root.MkdirAll(CleanPath(rel), 0o755))
}

func (m *Manager) Rename(id, from, to string) error {
	f, t := CleanPath(from), CleanPath(to)
	if f == "." || t == "." {
		return tunnel.BadRequest("cannot rename the server root")
	}
	root, err := m.OpenRoot(id)
	if err != nil {
		return err
	}
	defer root.Close()
	if _, err := root.Lstat(t); err == nil {
		return tunnel.Conflict("target already exists")
	}
	return mapFSErr(root.Rename(f, t))
}

// DeleteFiles removes files or directories inside the server root.
func (m *Manager) DeleteFiles(id string, paths []string) error {
	root, err := m.OpenRoot(id)
	if err != nil {
		return err
	}
	defer root.Close()
	defer m.invalidateDisk(id)
	for _, p := range paths {
		name := CleanPath(p)
		if name == "." {
			return tunnel.BadRequest("cannot delete the server root")
		}
		if err := root.RemoveAll(name); err != nil {
			return mapFSErr(err)
		}
	}
	return nil
}

// ---------------------------------------------------------------------------
// Transfers
// ---------------------------------------------------------------------------

// Download streams a file in chunks via send.
func (m *Manager) Download(id, rel string, send func([]byte) error) error {
	root, err := m.OpenRoot(id)
	if err != nil {
		return err
	}
	defer root.Close()
	f, err := root.Open(CleanPath(rel))
	if err != nil {
		return mapFSErr(err)
	}
	defer f.Close()
	if info, err := f.Stat(); err != nil || !info.Mode().IsRegular() {
		return tunnel.BadRequest("not a regular file")
	}
	buf := make([]byte, transferChunk)
	for {
		n, err := f.Read(buf)
		if n > 0 {
			if err := send(append([]byte(nil), buf[:n]...)); err != nil {
				return err
			}
		}
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return err
		}
	}
}

// Upload writes chunks from recv into a temp file and renames it into place
// once the panel signalled EOF. Aborted uploads leave nothing behind.
// ack is called after every written chunk: the panel keeps at most a small
// window of unacknowledged chunks in flight, so the stream buffer never
// overflows (it drops data instead of blocking the tunnel).
func (m *Manager) Upload(id, rel string, size, limit uint64, recv <-chan []byte, done <-chan struct{}, ack func() error) error {
	name := CleanPath(rel)
	if name == "." {
		return tunnel.BadRequest("path required")
	}
	if err := m.CheckQuota(id, limit, size); err != nil {
		return err
	}
	root, err := m.OpenRoot(id)
	if err != nil {
		return err
	}
	defer root.Close()
	defer m.invalidateDisk(id)
	if dir := path.Dir(name); dir != "." {
		if err := root.MkdirAll(dir, 0o755); err != nil {
			return mapFSErr(err)
		}
	}
	tmp := tempName(name)
	f, err := root.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	if err != nil {
		return mapFSErr(err)
	}
	ok := false
	defer func() {
		_ = f.Close()
		if !ok {
			_ = root.Remove(tmp)
		}
	}()

	var written uint64
	budget := uint64(0)
	if limit > 0 {
		budget = limit - min(limit, m.DiskUsage(id))
	}
	for {
		select {
		case <-done:
			return errors.New("upload aborted")
		case chunk, open := <-recv:
			if !open {
				if err := f.Close(); err != nil {
					return err
				}
				if err := root.Rename(tmp, name); err != nil {
					return mapFSErr(err)
				}
				ok = true
				return nil
			}
			written += uint64(len(chunk))
			if budget > 0 && written > budget {
				return &tunnel.Error{Code: 507, Message: "disk limit reached"}
			}
			if _, err := f.Write(chunk); err != nil {
				return err
			}
			if err := ack(); err != nil {
				return err
			}
		}
	}
}

func tempName(name string) string {
	b := make([]byte, 6)
	_, _ = rand.Read(b)
	return path.Join(path.Dir(name), ".upload-"+hex.EncodeToString(b)+".tmp")
}

// ---------------------------------------------------------------------------
// Archives
// ---------------------------------------------------------------------------

// Compress packs paths (relative to dir) into a tar.gz inside dir.
func (m *Manager) Compress(id, dir string, paths []string, limit uint64) (string, error) {
	if len(paths) == 0 {
		return "", tunnel.BadRequest("nothing to compress")
	}
	if err := m.CheckQuota(id, limit, 0); err != nil {
		return "", err
	}
	root, err := m.OpenRoot(id)
	if err != nil {
		return "", err
	}
	defer root.Close()
	defer m.invalidateDisk(id)
	base := CleanPath(dir)
	archive := path.Join(base, "archive-"+time.Now().Format("2006-01-02-150405")+".tar.gz")
	out, err := root.OpenFile(archive, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	if err != nil {
		return "", mapFSErr(err)
	}
	ok := false
	defer func() {
		_ = out.Close()
		if !ok {
			_ = root.Remove(archive)
		}
	}()
	gz := gzip.NewWriter(out)
	tw := tar.NewWriter(gz)
	fsys := root.FS()
	for _, p := range paths {
		start := path.Join(base, CleanPath(p))
		err := fs.WalkDir(fsys, start, func(p string, d fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if p == archive {
				return nil
			}
			info, err := d.Info()
			if err != nil || info.Mode()&fs.ModeSymlink != 0 || !(info.IsDir() || info.Mode().IsRegular()) {
				return nil // skip symlinks, devices, sockets
			}
			hdr, err := tar.FileInfoHeader(info, "")
			if err != nil {
				return err
			}
			rel := p
			if base != "." {
				rel = strings.TrimPrefix(p, base+"/")
			}
			hdr.Name = rel
			if info.IsDir() {
				hdr.Name += "/"
			}
			if err := tw.WriteHeader(hdr); err != nil {
				return err
			}
			if info.Mode().IsRegular() {
				f, err := fsys.Open(p)
				if err != nil {
					return err
				}
				_, err = io.Copy(tw, f)
				f.Close()
				return err
			}
			return nil
		})
		if err != nil {
			return "", mapFSErr(err)
		}
	}
	if err := tw.Close(); err != nil {
		return "", err
	}
	if err := gz.Close(); err != nil {
		return "", err
	}
	if err := out.Close(); err != nil {
		return "", err
	}
	ok = true
	return archive, nil
}

// Decompress extracts .tar, .tar.gz/.tgz or .zip into dir. Only regular
// files and directories are created; the total size is capped by the disk
// limit (or a fixed budget) to stop zip bombs.
func (m *Manager) Decompress(id, dir, archive string, limit uint64) error {
	root, err := m.OpenRoot(id)
	if err != nil {
		return err
	}
	defer root.Close()
	defer m.invalidateDisk(id)

	budget := uint64(unlimitedExtractBudget)
	if limit > 0 {
		used := m.DiskUsage(id)
		if used >= limit {
			return &tunnel.Error{Code: 507, Message: "disk limit reached"}
		}
		budget = limit - used
	}
	ex := &extractor{root: root, base: CleanPath(dir), budget: budget}

	name := CleanPath(archive)
	f, err := root.Open(name)
	if err != nil {
		return mapFSErr(err)
	}
	defer f.Close()
	lower := strings.ToLower(name)
	switch {
	case strings.HasSuffix(lower, ".zip"):
		info, err := f.Stat()
		if err != nil {
			return err
		}
		zr, err := zip.NewReader(f, info.Size())
		if err != nil {
			return tunnel.BadRequest("invalid zip archive")
		}
		for _, zf := range zr.File {
			if err := ex.entry(zf.Name, zf.FileInfo(), func() (io.ReadCloser, error) { return zf.Open() }); err != nil {
				return err
			}
		}
	case strings.HasSuffix(lower, ".tar.gz"), strings.HasSuffix(lower, ".tgz"), strings.HasSuffix(lower, ".tar"):
		var r io.Reader = f
		if !strings.HasSuffix(lower, ".tar") {
			gz, err := gzip.NewReader(f)
			if err != nil {
				return tunnel.BadRequest("invalid gzip archive")
			}
			defer gz.Close()
			r = gz
		}
		tr := tar.NewReader(r)
		for {
			hdr, err := tr.Next()
			if errors.Is(err, io.EOF) {
				break
			}
			if err != nil {
				return tunnel.BadRequest("invalid tar archive: " + err.Error())
			}
			if err := ex.entry(hdr.Name, hdr.FileInfo(), func() (io.ReadCloser, error) { return io.NopCloser(tr), nil }); err != nil {
				return err
			}
		}
	default:
		return tunnel.BadRequest("unsupported archive type (zip, tar, tar.gz)")
	}
	return nil
}

type extractor struct {
	root    *os.Root
	base    string
	budget  uint64
	written uint64
	entries int
}

func (e *extractor) entry(name string, info fs.FileInfo, open func() (io.ReadCloser, error)) error {
	e.entries++
	if e.entries > maxArchiveEntries {
		return tunnel.BadRequest("archive has too many entries")
	}
	target := path.Join(e.base, CleanPath(name))
	switch {
	case info.IsDir():
		return mapFSErr(e.root.MkdirAll(target, 0o755))
	case info.Mode().IsRegular():
		if d := path.Dir(target); d != "." {
			if err := e.root.MkdirAll(d, 0o755); err != nil {
				return mapFSErr(err)
			}
		}
		rc, err := open()
		if err != nil {
			return err
		}
		defer rc.Close()
		out, err := e.root.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o644)
		if err != nil {
			return mapFSErr(err)
		}
		defer out.Close()
		remaining := e.budget - e.written
		n, err := io.Copy(out, io.LimitReader(rc, int64(remaining)+1))
		e.written += uint64(n)
		if err != nil {
			return err
		}
		if e.written > e.budget {
			return &tunnel.Error{Code: 507, Message: "archive exceeds the disk limit"}
		}
		return nil
	default:
		return nil // symlinks, devices etc. are skipped on purpose
	}
}
