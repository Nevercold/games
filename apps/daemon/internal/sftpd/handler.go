package sftpd

import (
	"errors"
	"io"
	"io/fs"
	"os"
	"path"
	"strings"
	"sync"

	"github.com/pkg/sftp"
)

var ioEOF = io.EOF

// handler implements the pkg/sftp request handlers on top of os.Root.
type handler struct {
	grant   *Grant
	backend Backend
}

func clean(p string) string {
	c := strings.TrimPrefix(path.Clean("/"+p), "/")
	if c == "" {
		return "."
	}
	return c
}

func (h *handler) root() (*os.Root, error) {
	return h.backend.OpenRoot(h.grant.ServerID)
}

func mapErr(err error) error {
	switch {
	case err == nil:
		return nil
	case errors.Is(err, fs.ErrNotExist):
		return sftp.ErrSSHFxNoSuchFile
	case errors.Is(err, fs.ErrPermission), strings.Contains(err.Error(), "path escapes"):
		return sftp.ErrSSHFxPermissionDenied
	}
	return sftp.ErrSSHFxFailure
}

// rootFile keeps the os.Root open as long as the file is in use.
type rootFile struct {
	*os.File
	root *os.Root
	once sync.Once
	done func()
}

func (f *rootFile) Close() error {
	err := f.File.Close()
	f.once.Do(func() {
		_ = f.root.Close()
		if f.done != nil {
			f.done()
		}
	})
	return err
}

// Fileread opens a file for download (file.read-content).
func (h *handler) Fileread(r *sftp.Request) (io.ReaderAt, error) {
	if !h.grant.can("file.read-content") {
		return nil, sftp.ErrSSHFxPermissionDenied
	}
	root, err := h.root()
	if err != nil {
		return nil, mapErr(err)
	}
	f, err := root.Open(clean(r.Filepath))
	if err != nil {
		root.Close()
		return nil, mapErr(err)
	}
	return &rootFile{File: f, root: root}, nil
}

// quotaFile stops writes once the server would exceed its disk limit.
type quotaFile struct {
	*rootFile
	mu     sync.Mutex
	budget int64 // remaining bytes, <0 = unlimited
	high   int64
}

func (q *quotaFile) WriteAt(p []byte, off int64) (int, error) {
	q.mu.Lock()
	end := off + int64(len(p))
	if q.budget >= 0 && end > q.high && end-q.high > q.budget {
		q.mu.Unlock()
		return 0, sftp.ErrSSHFxFailure
	}
	if end > q.high {
		if q.budget >= 0 {
			q.budget -= end - q.high
		}
		q.high = end
	}
	q.mu.Unlock()
	return q.rootFile.WriteAt(p, off)
}

// Filewrite opens a file for upload: file.create for new files,
// file.update for existing ones.
func (h *handler) Filewrite(r *sftp.Request) (io.WriterAt, error) {
	root, err := h.root()
	if err != nil {
		return nil, mapErr(err)
	}
	name := clean(r.Filepath)
	if name == "." {
		root.Close()
		return nil, sftp.ErrSSHFxPermissionDenied
	}
	_, statErr := root.Lstat(name)
	exists := statErr == nil
	if (exists && !h.grant.can("file.update")) || (!exists && !h.grant.can("file.create")) {
		root.Close()
		return nil, sftp.ErrSSHFxPermissionDenied
	}
	budget := int64(-1)
	if limit := h.grant.DiskLimit; limit > 0 {
		used := h.backend.DiskUsage(h.grant.ServerID)
		if used >= limit {
			root.Close()
			return nil, sftp.ErrSSHFxFailure
		}
		budget = int64(limit - used)
	}
	flags := os.O_WRONLY | os.O_CREATE
	if pf := r.Pflags(); pf.Trunc {
		flags |= os.O_TRUNC
	}
	f, err := root.OpenFile(name, flags, 0o644)
	if err != nil {
		root.Close()
		return nil, mapErr(err)
	}
	return &quotaFile{
		rootFile: &rootFile{File: f, root: root, done: func() { h.backend.InvalidateDisk(h.grant.ServerID) }},
		budget:   budget,
	}, nil
}

// Filecmd handles rename, remove, mkdir and setstat.
func (h *handler) Filecmd(r *sftp.Request) error {
	root, err := h.root()
	if err != nil {
		return mapErr(err)
	}
	defer root.Close()
	name := clean(r.Filepath)
	switch r.Method {
	case "Setstat":
		return nil // permissions and times are managed by the daemon
	case "Rename", "PosixRename":
		if !h.grant.can("file.update") {
			return sftp.ErrSSHFxPermissionDenied
		}
		target := clean(r.Target)
		if name == "." || target == "." {
			return sftp.ErrSSHFxPermissionDenied
		}
		if r.Method == "Rename" {
			if _, err := root.Lstat(target); err == nil {
				return sftp.ErrSSHFxFailure
			}
		}
		return mapErr(root.Rename(name, target))
	case "Rmdir", "Remove":
		if !h.grant.can("file.delete") || name == "." {
			return sftp.ErrSSHFxPermissionDenied
		}
		defer h.backend.InvalidateDisk(h.grant.ServerID)
		// Rmdir only removes empty directories (SFTP semantics); clients
		// delete recursively file by file.
		return mapErr(root.Remove(name))
	case "Mkdir":
		if !h.grant.can("file.create") {
			return sftp.ErrSSHFxPermissionDenied
		}
		return mapErr(root.Mkdir(name, 0o755))
	}
	// Symlinks and hard links are not allowed: they could point outside.
	return sftp.ErrSSHFxOpUnsupported
}

type listerAt []os.FileInfo

func (l listerAt) ListAt(out []os.FileInfo, offset int64) (int, error) {
	if offset >= int64(len(l)) {
		return 0, io.EOF
	}
	n := copy(out, l[offset:])
	if n < len(out) {
		return n, io.EOF
	}
	return n, nil
}

// Filelist handles List, Stat and Lstat (file.read).
func (h *handler) Filelist(r *sftp.Request) (sftp.ListerAt, error) {
	if !h.grant.can("file.read") {
		return nil, sftp.ErrSSHFxPermissionDenied
	}
	root, err := h.root()
	if err != nil {
		return nil, mapErr(err)
	}
	defer root.Close()
	name := clean(r.Filepath)
	switch r.Method {
	case "List":
		dir, err := root.Open(name)
		if err != nil {
			return nil, mapErr(err)
		}
		defer dir.Close()
		entries, err := dir.ReadDir(-1)
		if err != nil {
			return nil, mapErr(err)
		}
		infos := make([]os.FileInfo, 0, len(entries))
		for _, e := range entries {
			if strings.HasPrefix(e.Name(), ".upload-") {
				continue
			}
			if info, err := e.Info(); err == nil {
				infos = append(infos, info)
			}
		}
		return listerAt(infos), nil
	case "Stat":
		info, err := root.Stat(name)
		if err != nil {
			return nil, mapErr(err)
		}
		return listerAt{info}, nil
	case "Lstat":
		info, err := root.Lstat(name)
		if err != nil {
			return nil, mapErr(err)
		}
		return listerAt{info}, nil
	}
	return nil, sftp.ErrSSHFxOpUnsupported
}
