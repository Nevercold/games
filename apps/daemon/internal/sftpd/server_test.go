package sftpd

import (
	"context"
	"errors"
	"io"
	"io/fs"
	"log/slog"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"
)

// testBackend serves one directory as the server root.
type testBackend struct{ dir string }

func (b testBackend) OpenRoot(string) (*os.Root, error) { return os.OpenRoot(b.dir) }
func (b testBackend) DiskUsage(string) uint64 {
	var n uint64
	_ = filepath.WalkDir(b.dir, func(_ string, d fs.DirEntry, err error) error {
		if err == nil && !d.IsDir() {
			if info, err := d.Info(); err == nil {
				n += uint64(info.Size())
			}
		}
		return nil
	})
	return n
}
func (testBackend) InvalidateDisk(string) {}

func startServer(t *testing.T, perms []string, limit uint64) (addr, dir string) {
	t.Helper()
	dir = t.TempDir()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr = ln.Addr().String()
	ln.Close()

	grantPerms := map[string]bool{}
	for _, p := range perms {
		grantPerms[p] = true
	}
	srv := &Server{
		Addr:        addr,
		HostKeyPath: filepath.Join(t.TempDir(), "host_key"),
		Backend:     testBackend{dir},
		Log:         slog.New(slog.NewTextHandler(io.Discard, nil)),
		Auth: func(_ context.Context, user, pass, _ string) (*Grant, error) {
			if user == "alice.12345678" && pass == "correct horse" {
				return &Grant{ServerID: "srv", Permissions: grantPerms, DiskLimit: limit}, nil
			}
			return nil, errors.New("denied")
		},
	}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	go func() { _ = srv.Run(ctx) }()
	for i := 0; i < 50; i++ {
		if c, err := net.Dial("tcp", addr); err == nil {
			c.Close()
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	return addr, dir
}

func dial(t *testing.T, addr, user, pass string) (*sftp.Client, error) {
	t.Helper()
	conn, err := ssh.Dial("tcp", addr, &ssh.ClientConfig{
		User:            user,
		Auth:            []ssh.AuthMethod{ssh.Password(pass)},
		HostKeyCallback: ssh.InsecureIgnoreHostKey(),
		Timeout:         5 * time.Second,
	})
	if err != nil {
		return nil, err
	}
	t.Cleanup(func() { conn.Close() })
	return sftp.NewClient(conn)
}

func TestWrongPasswordIsRejected(t *testing.T) {
	addr, _ := startServer(t, []string{"file.read"}, 0)
	if _, err := dial(t, addr, "alice.12345678", "wrong"); err == nil {
		t.Fatal("login with wrong password succeeded")
	}
}

func TestFullAccessRoundtrip(t *testing.T) {
	addr, dir := startServer(t, []string{"file.read", "file.read-content", "file.create", "file.update", "file.delete"}, 0)
	c, err := dial(t, addr, "alice.12345678", "correct horse")
	if err != nil {
		t.Fatal(err)
	}
	if err := c.MkdirAll("/plugins/conf"); err != nil {
		t.Fatal(err)
	}
	f, err := c.Create("/plugins/conf/a.yml")
	if err != nil {
		t.Fatal(err)
	}
	_, _ = f.Write([]byte("key: value\n"))
	f.Close()
	if got, _ := os.ReadFile(filepath.Join(dir, "plugins/conf/a.yml")); string(got) != "key: value\n" {
		t.Fatalf("file content = %q", got)
	}
	r, err := c.Open("/plugins/conf/a.yml")
	if err != nil {
		t.Fatal(err)
	}
	data, _ := io.ReadAll(r)
	r.Close()
	if string(data) != "key: value\n" {
		t.Fatalf("download = %q", data)
	}
	if err := c.Rename("/plugins/conf/a.yml", "/plugins/conf/b.yml"); err != nil {
		t.Fatal(err)
	}
	entries, err := c.ReadDir("/plugins/conf")
	if err != nil || len(entries) != 1 || entries[0].Name() != "b.yml" {
		t.Fatalf("listing after rename: %v %v", entries, err)
	}
	if err := c.Remove("/plugins/conf/b.yml"); err != nil {
		t.Fatal(err)
	}
}

func TestPermissionsAreEnforced(t *testing.T) {
	addr, dir := startServer(t, []string{"file.read"}, 0)
	if err := os.WriteFile(filepath.Join(dir, "secret.txt"), []byte("s"), 0o644); err != nil {
		t.Fatal(err)
	}
	c, err := dial(t, addr, "alice.12345678", "correct horse")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := c.ReadDir("/"); err != nil {
		t.Fatalf("listing should be allowed: %v", err)
	}
	if _, err := c.Open("/secret.txt"); err == nil {
		t.Fatal("download without file.read-content succeeded")
	}
	if _, err := c.Create("/new.txt"); err == nil {
		t.Fatal("upload without file.create succeeded")
	}
	if err := c.Remove("/secret.txt"); err == nil {
		t.Fatal("delete without file.delete succeeded")
	}
	if err := c.Symlink("/etc/passwd", "/link"); err == nil {
		t.Fatal("symlink creation must be refused")
	}
}

func TestEscapesAreBlocked(t *testing.T) {
	addr, dir := startServer(t, []string{"file.read", "file.read-content", "file.create", "file.update"}, 0)
	outside := t.TempDir()
	_ = os.WriteFile(filepath.Join(outside, "host-secret"), []byte("x"), 0o600)
	if err := os.Symlink(outside, filepath.Join(dir, "evil")); err != nil {
		t.Fatal(err)
	}
	c, err := dial(t, addr, "alice.12345678", "correct horse")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := c.Open("/evil/host-secret"); err == nil {
		t.Fatal("read through symlink escaped the root")
	}
	if f, err := c.Create("/evil/planted"); err == nil {
		f.Close()
		t.Fatal("write through symlink escaped the root")
	}
	// "../" is resolved against the virtual root and stays inside.
	f, err := c.Create("/../../../escape.txt")
	if err != nil {
		t.Fatal(err)
	}
	f.Close()
	if _, err := os.Stat(filepath.Join(dir, "escape.txt")); err != nil {
		t.Fatal("dot-dot path should land inside the root")
	}
}

func TestDiskLimit(t *testing.T) {
	addr, _ := startServer(t, []string{"file.read", "file.create", "file.update"}, 1000)
	c, err := dial(t, addr, "alice.12345678", "correct horse")
	if err != nil {
		t.Fatal(err)
	}
	f, err := c.Create("/big.bin")
	if err != nil {
		t.Fatal(err)
	}
	_, werr := f.Write([]byte(strings.Repeat("x", 5000)))
	cerr := f.Close()
	if werr == nil && cerr == nil {
		t.Fatal("write beyond the disk limit succeeded")
	}
}

// TestLiveLogin checks a real daemon+panel when SFTP_LIVE="host:port|user|password" is set.
func TestLiveLogin(t *testing.T) {
	spec := os.Getenv("SFTP_LIVE")
	if spec == "" {
		t.Skip("set SFTP_LIVE=host:port|user|password to test against a running daemon")
	}
	parts := strings.SplitN(spec, "|", 3)
	c, err := dial(t, parts[0], parts[1], parts[2])
	if err != nil {
		t.Fatalf("live login failed: %v", err)
	}
	entries, err := c.ReadDir("/")
	if err != nil {
		t.Fatalf("live listing failed: %v", err)
	}
	t.Logf("live listing: %d entries", len(entries))
	if want := os.Getenv("SFTP_LIVE_EXPECT_DENY"); want != "" {
		if _, err := c.Create("/" + want); err == nil {
			t.Fatalf("expected upload of %q to be denied", want)
		}
	}
}
