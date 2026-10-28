package backup

import (
	"context"
	"errors"
	"io"
	"io/fs"
	"os"
	"path"

	"panel/daemon/internal/tunnel"
)

// LocalConfig stores backups in the node's backup directory.
type LocalConfig struct {
	// Subdir inside the node backup directory (optional).
	Subdir string `json:"subdir,omitempty"`
}

type localStore struct{ root *os.Root }

func openLocal(base string, c LocalConfig) (Store, error) {
	if base == "" {
		return nil, errors.New("node has no backup directory configured")
	}
	if err := os.MkdirAll(base, 0o700); err != nil {
		return nil, err
	}
	dir := base
	if c.Subdir != "" {
		if err := ValidKey(c.Subdir); err != nil {
			return nil, tunnel.BadRequest("invalid subdir")
		}
		r, err := os.OpenRoot(base)
		if err != nil {
			return nil, err
		}
		err = r.MkdirAll(c.Subdir, 0o700)
		r.Close()
		if err != nil {
			return nil, err
		}
		dir = base + string(os.PathSeparator) + c.Subdir
	}
	root, err := os.OpenRoot(dir)
	if err != nil {
		return nil, err
	}
	return &localStore{root: root}, nil
}

func (s *localStore) Put(_ context.Context, key string, r io.Reader) error {
	if err := ValidKey(key); err != nil {
		return err
	}
	if d := path.Dir(key); d != "." {
		if err := s.root.MkdirAll(d, 0o700); err != nil {
			return err
		}
	}
	tmp := key + ".part"
	f, err := s.root.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	_, err = io.Copy(f, r)
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		_ = s.root.Remove(tmp)
		return err
	}
	return s.root.Rename(tmp, key)
}

func (s *localStore) Get(_ context.Context, key string) (io.ReadCloser, error) {
	if err := ValidKey(key); err != nil {
		return nil, err
	}
	f, err := s.root.Open(key)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, tunnel.NotFound("backup archive not found")
	}
	return f, err
}

func (s *localStore) Delete(_ context.Context, key string) error {
	if err := ValidKey(key); err != nil {
		return err
	}
	err := s.root.Remove(key)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	return err
}

func (s *localStore) Close() error { return s.root.Close() }
