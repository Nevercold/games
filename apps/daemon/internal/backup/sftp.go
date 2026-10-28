package backup

import (
	"context"
	"errors"
	"io"
	"io/fs"
	"net"
	"path"
	"strconv"
	"time"

	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"

	"panel/daemon/internal/tunnel"
)

// SFTPConfig targets a remote SFTP server. The host key must be pinned:
// an empty HostKey only allows the connection test, which reports the
// fingerprint so an admin can confirm and store it.
type SFTPConfig struct {
	Host     string `json:"host"`
	Port     int    `json:"port,omitempty"`
	Username string `json:"username"`
	Password string `json:"password,omitempty"`
	// PrivateKey in OpenSSH/PEM format (unencrypted).
	PrivateKey string `json:"privateKey,omitempty"`
	// Path of the backup directory on the remote server.
	Path string `json:"path,omitempty"`
	// HostKey is the SHA256 fingerprint ("SHA256:...") of the server key.
	HostKey string `json:"hostKey"`
}

type sftpStore struct {
	conn *ssh.Client
	c    *sftp.Client
	base string
}

var errHostKeyNotPinned = errors.New("host key not pinned")

func openSFTP(ctx context.Context, c SFTPConfig) (Store, string, error) {
	if c.Host == "" || c.Username == "" {
		return nil, "", tunnel.BadRequest("sftp target needs host and username")
	}
	var auth []ssh.AuthMethod
	if c.PrivateKey != "" {
		signer, err := ssh.ParsePrivateKey([]byte(c.PrivateKey))
		if err != nil {
			return nil, "", tunnel.BadRequest("sftp private key: " + err.Error())
		}
		auth = append(auth, ssh.PublicKeys(signer))
	}
	if c.Password != "" {
		auth = append(auth, ssh.Password(c.Password))
	}
	if len(auth) == 0 {
		return nil, "", tunnel.BadRequest("sftp target needs a password or private key")
	}
	port := c.Port
	if port == 0 {
		port = 22
	}
	var seen string
	cfg := &ssh.ClientConfig{
		User: c.Username,
		Auth: auth,
		HostKeyCallback: func(_ string, _ net.Addr, key ssh.PublicKey) error {
			seen = ssh.FingerprintSHA256(key)
			if c.HostKey == "" {
				return errHostKeyNotPinned
			}
			if seen != c.HostKey {
				return errors.New("host key mismatch (got " + seen + ")")
			}
			return nil
		},
		Timeout: 15 * time.Second,
	}
	addr := net.JoinHostPort(c.Host, strconv.Itoa(port))
	d := net.Dialer{Timeout: 15 * time.Second}
	raw, err := d.DialContext(ctx, "tcp", addr)
	if err != nil {
		return nil, "", err
	}
	sc, chans, reqs, err := ssh.NewClientConn(raw, addr, cfg)
	if err != nil {
		raw.Close()
		if errors.Is(err, errHostKeyNotPinned) {
			return nil, seen, &tunnel.Error{Code: 412, Message: "host key not pinned: confirm fingerprint " + seen}
		}
		return nil, seen, err
	}
	conn := ssh.NewClient(sc, chans, reqs)
	client, err := sftp.NewClient(conn, sftp.UseConcurrentWrites(true))
	if err != nil {
		conn.Close()
		return nil, seen, err
	}
	base := c.Path
	if base == "" {
		base = "."
	}
	return &sftpStore{conn: conn, c: client, base: path.Clean(base)}, seen, nil
}

func (s *sftpStore) full(key string) (string, error) {
	if err := ValidKey(key); err != nil {
		return "", err
	}
	return path.Join(s.base, key), nil
}

func (s *sftpStore) Put(_ context.Context, key string, r io.Reader) error {
	p, err := s.full(key)
	if err != nil {
		return err
	}
	if err := s.c.MkdirAll(path.Dir(p)); err != nil {
		return err
	}
	tmp := p + ".part"
	f, err := s.c.Create(tmp)
	if err != nil {
		return err
	}
	_, err = f.ReadFrom(r)
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		_ = s.c.Remove(tmp)
		return err
	}
	// PosixRename overwrites atomically where supported; plain Rename fails
	// on existing targets, so fall back to remove + rename.
	if err := s.c.PosixRename(tmp, p); err != nil {
		_ = s.c.Remove(p)
		if err := s.c.Rename(tmp, p); err != nil {
			_ = s.c.Remove(tmp)
			return err
		}
	}
	return nil
}

func (s *sftpStore) Get(_ context.Context, key string) (io.ReadCloser, error) {
	p, err := s.full(key)
	if err != nil {
		return nil, err
	}
	f, err := s.c.Open(p)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, tunnel.NotFound("backup archive not found")
	}
	return f, err
}

func (s *sftpStore) Delete(_ context.Context, key string) error {
	p, err := s.full(key)
	if err != nil {
		return err
	}
	err = s.c.Remove(p)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	return err
}

func (s *sftpStore) Close() error {
	s.c.Close()
	return s.conn.Close()
}
