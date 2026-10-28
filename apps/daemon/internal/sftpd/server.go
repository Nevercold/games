// Package sftpd is the built-in SFTP server. Logins are checked by the panel
// (over the tunnel); every file operation is limited to the server directory
// via os.Root and to the user's file.* permissions.
package sftpd

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/pem"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"
)

// Grant is what a successful login gives access to.
type Grant struct {
	ServerID    string
	Permissions map[string]bool
	DiskLimit   uint64
}

func (g *Grant) can(p string) bool { return g.Permissions[p] }

// Authenticator validates credentials (implemented by a panel RPC).
type Authenticator func(ctx context.Context, username, password, remoteIP string) (*Grant, error)

// Backend gives access to server directories.
type Backend interface {
	OpenRoot(serverID string) (*os.Root, error)
	DiskUsage(serverID string) uint64
	InvalidateDisk(serverID string)
}

// Server is the SFTP endpoint of a node.
type Server struct {
	Addr        string
	HostKeyPath string
	Auth        Authenticator
	Backend     Backend
	Log         *slog.Logger

	failMu   sync.Mutex
	failures map[string][]time.Time
}

const (
	maxFailuresPerMinute = 10
	authTimeout          = 10 * time.Second
)

// Run listens until ctx is cancelled.
func (s *Server) Run(ctx context.Context) error {
	signer, err := loadOrCreateHostKey(s.HostKeyPath)
	if err != nil {
		return fmt.Errorf("sftp host key: %w", err)
	}
	s.failures = map[string][]time.Time{}

	cfg := &ssh.ServerConfig{
		PasswordCallback: s.passwordCallback,
		MaxAuthTries:     3,
		ServerVersion:    "SSH-2.0-PanelDaemon",
	}
	cfg.AddHostKey(signer)

	ln, err := net.Listen("tcp", s.Addr)
	if err != nil {
		return err
	}
	s.Log.Info("sftp listening", "addr", s.Addr, "fingerprint", ssh.FingerprintSHA256(signer.PublicKey()))
	go func() {
		<-ctx.Done()
		_ = ln.Close()
	}()
	for {
		conn, err := ln.Accept()
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			s.Log.Warn("sftp accept failed", "err", err)
			continue
		}
		go s.handleConn(conn, cfg)
	}
}

func (s *Server) tooManyFailures(ip string) bool {
	s.failMu.Lock()
	defer s.failMu.Unlock()
	cutoff := time.Now().Add(-time.Minute)
	recent := s.failures[ip][:0]
	for _, t := range s.failures[ip] {
		if t.After(cutoff) {
			recent = append(recent, t)
		}
	}
	s.failures[ip] = recent
	return len(recent) >= maxFailuresPerMinute
}

func (s *Server) recordFailure(ip string) {
	s.failMu.Lock()
	s.failures[ip] = append(s.failures[ip], time.Now())
	s.failMu.Unlock()
}

func (s *Server) passwordCallback(meta ssh.ConnMetadata, password []byte) (*ssh.Permissions, error) {
	ip, _, _ := net.SplitHostPort(meta.RemoteAddr().String())
	if s.tooManyFailures(ip) {
		return nil, errors.New("too many failed attempts")
	}
	ctx, cancel := context.WithTimeout(context.Background(), authTimeout)
	defer cancel()
	grant, err := s.Auth(ctx, meta.User(), string(password), ip)
	if err != nil || grant == nil || grant.ServerID == "" {
		s.recordFailure(ip)
		s.Log.Info("sftp login failed", "user", meta.User(), "ip", ip)
		return nil, errors.New("invalid credentials")
	}
	perms := make([]string, 0, len(grant.Permissions))
	for p := range grant.Permissions {
		perms = append(perms, p)
	}
	return &ssh.Permissions{Extensions: map[string]string{
		"server":      grant.ServerID,
		"permissions": strings.Join(perms, ","),
		"disk_limit":  strconv.FormatUint(grant.DiskLimit, 10),
	}}, nil
}

func (s *Server) handleConn(nc net.Conn, cfg *ssh.ServerConfig) {
	defer nc.Close()
	_ = nc.SetDeadline(time.Now().Add(30 * time.Second)) // handshake deadline
	sconn, chans, reqs, err := ssh.NewServerConn(nc, cfg)
	if err != nil {
		return
	}
	defer sconn.Close()
	_ = nc.SetDeadline(time.Time{})
	go ssh.DiscardRequests(reqs)

	grant := &Grant{ServerID: sconn.Permissions.Extensions["server"], Permissions: map[string]bool{}}
	for _, p := range strings.Split(sconn.Permissions.Extensions["permissions"], ",") {
		if p != "" {
			grant.Permissions[p] = true
		}
	}
	grant.DiskLimit, _ = strconv.ParseUint(sconn.Permissions.Extensions["disk_limit"], 10, 64)
	s.Log.Info("sftp session", "user", sconn.User(), "server", grant.ServerID, "ip", sconn.RemoteAddr().String())

	for newCh := range chans {
		if newCh.ChannelType() != "session" {
			_ = newCh.Reject(ssh.UnknownChannelType, "only sessions are supported")
			continue
		}
		ch, requests, err := newCh.Accept()
		if err != nil {
			continue
		}
		go func() {
			for req := range requests {
				ok := req.Type == "subsystem" && len(req.Payload) >= 4 && string(req.Payload[4:]) == "sftp"
				_ = req.Reply(ok, nil)
			}
		}()
		go s.serveSFTP(ch, grant)
	}
}

func (s *Server) serveSFTP(ch ssh.Channel, grant *Grant) {
	defer ch.Close()
	h := &handler{grant: grant, backend: s.Backend}
	srv := sftp.NewRequestServer(ch, sftp.Handlers{FileGet: h, FilePut: h, FileCmd: h, FileList: h})
	defer srv.Close()
	if err := srv.Serve(); err != nil && !errors.Is(err, ioEOF) {
		s.Log.Debug("sftp session ended", "err", err)
	}
}

func loadOrCreateHostKey(path string) (ssh.Signer, error) {
	if data, err := os.ReadFile(path); err == nil {
		return ssh.ParsePrivateKey(data)
	}
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return nil, err
	}
	block, err := ssh.MarshalPrivateKey(priv, "panel daemon sftp host key")
	if err != nil {
		return nil, err
	}
	data := pem.EncodeToMemory(block)
	if err := os.WriteFile(path, data, 0o600); err != nil {
		return nil, err
	}
	return ssh.ParsePrivateKey(data)
}
