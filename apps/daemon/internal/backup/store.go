// Package backup implements the storage targets backups are streamed to:
// a directory on the node, S3-compatible object storage and SFTP servers.
// Target credentials come from the panel with every call and are never
// written to disk by the daemon.
package backup

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"regexp"
	"strings"

	panelv1 "panel/daemon/internal/pb/panel/v1"
	"panel/daemon/internal/tunnel"
)

// Store is one backup target.
type Store interface {
	// Put streams r to key. A failed Put leaves no partial object behind
	// where the target allows it (temp name + rename).
	Put(ctx context.Context, key string, r io.Reader) error
	Get(ctx context.Context, key string) (io.ReadCloser, error)
	Delete(ctx context.Context, key string) error
	Close() error
}

// keyRe allows "<dir>/<name>" style keys without traversal.
var keyRe = regexp.MustCompile(`^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$`)

// ValidKey rejects empty keys, absolute paths and ".." segments.
func ValidKey(key string) error {
	if !keyRe.MatchString(key) {
		return tunnel.BadRequest("invalid backup key")
	}
	for _, seg := range strings.Split(key, "/") {
		if seg == "." || seg == ".." {
			return tunnel.BadRequest("invalid backup key")
		}
	}
	return nil
}

// Open creates the store described by t. localDir is the node's backup
// directory; local targets can only choose a subdirectory inside it.
func Open(ctx context.Context, t *panelv1.BackupTarget, localDir string) (Store, error) {
	if t == nil {
		return nil, tunnel.BadRequest("backup target required")
	}
	dec := func(v any) error {
		d := json.NewDecoder(bytes.NewReader(t.Config))
		d.DisallowUnknownFields()
		if err := d.Decode(v); err != nil {
			return tunnel.BadRequest("invalid " + t.Type + " target config: " + err.Error())
		}
		return nil
	}
	switch t.Type {
	case "local":
		var c LocalConfig
		if len(t.Config) > 0 {
			if err := dec(&c); err != nil {
				return nil, err
			}
		}
		return openLocal(localDir, c)
	case "s3":
		var c S3Config
		if err := dec(&c); err != nil {
			return nil, err
		}
		return openS3(c)
	case "sftp":
		var c SFTPConfig
		if err := dec(&c); err != nil {
			return nil, err
		}
		s, _, err := openSFTP(ctx, c)
		return s, err
	default:
		return nil, tunnel.BadRequest(fmt.Sprintf("unknown backup target type %q", t.Type))
	}
}

// Test checks that the target accepts, returns and deletes an object.
// For SFTP it also returns the presented host key fingerprint, which is
// how an admin learns the value to pin.
func Test(ctx context.Context, t *panelv1.BackupTarget, localDir string) (string, error) {
	if t != nil && t.Type == "sftp" {
		var c SFTPConfig
		if err := json.Unmarshal(t.Config, &c); err != nil {
			return "", tunnel.BadRequest("invalid sftp target config")
		}
		s, fp, err := openSFTP(ctx, c)
		if err != nil {
			return fp, err
		}
		defer s.Close()
		return fp, roundTrip(ctx, s)
	}
	s, err := Open(ctx, t, localDir)
	if err != nil {
		return "", err
	}
	defer s.Close()
	return "", roundTrip(ctx, s)
}

func roundTrip(ctx context.Context, s Store) error {
	const key = ".panel-write-test"
	payload := []byte("panel backup target test")
	if err := s.Put(ctx, key, bytes.NewReader(payload)); err != nil {
		return fmt.Errorf("write: %w", err)
	}
	rc, err := s.Get(ctx, key)
	if err != nil {
		return fmt.Errorf("read: %w", err)
	}
	got, err := io.ReadAll(io.LimitReader(rc, 1024))
	rc.Close()
	if err != nil {
		return fmt.Errorf("read: %w", err)
	}
	if !bytes.Equal(got, payload) {
		return errors.New("read back different content")
	}
	if err := s.Delete(ctx, key); err != nil {
		return fmt.Errorf("delete: %w", err)
	}
	return nil
}
