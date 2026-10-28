package servers

import (
	"archive/zip"
	"bytes"
	"errors"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"testing"

	"panel/daemon/internal/tunnel"
)

const sid = "11111111-2222-3333-4444-555555555555"

func newTestManager(t *testing.T) (*Manager, string) {
	t.Helper()
	dir := t.TempDir()
	m, err := NewManager(Options{DataDir: dir, Logger: slog.New(slog.NewTextHandler(io.Discard, nil))})
	if err != nil {
		t.Fatal(err)
	}
	root := m.serverDir(sid)
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	return m, root
}

func errCode(err error) uint32 {
	var e *tunnel.Error
	if errors.As(err, &e) {
		return e.Code
	}
	return 0
}

func TestCleanPath(t *testing.T) {
	cases := map[string]string{
		"":          ".",
		"/":         ".",
		"a/b":       "a/b",
		"/a/../b":   "b",
		"../../etc": "etc",
		"..\\..\\x": "x",
		"a/./b//c":  "a/b/c",
	}
	for in, want := range cases {
		if got := CleanPath(in); got != want {
			t.Errorf("CleanPath(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestSymlinkEscapeIsBlocked(t *testing.T) {
	m, root := newTestManager(t)
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "secret"), []byte("top secret"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "evil")); err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := m.ReadFile(sid, "evil/secret", 0); err == nil {
		t.Fatal("read through symlink escaped the server root")
	}
	if err := m.WriteFile(sid, "evil/planted", []byte("x"), 0); err == nil {
		t.Fatal("write through symlink escaped the server root")
	}
	if _, err := os.Stat(filepath.Join(outside, "planted")); err == nil {
		t.Fatal("file was created outside the server root")
	}
}

func TestWriteReadRenameDelete(t *testing.T) {
	m, root := newTestManager(t)
	if err := m.WriteFile(sid, "cfg/server.properties", []byte("a=1\n"), 0); err != nil {
		t.Fatal(err)
	}
	data, size, truncated, err := m.ReadFile(sid, "/cfg/server.properties", 0)
	if err != nil || string(data) != "a=1\n" || size != 4 || truncated {
		t.Fatalf("read = %q %d %v %v", data, size, truncated, err)
	}
	if err := m.Rename(sid, "cfg/server.properties", "cfg/old.properties"); err != nil {
		t.Fatal(err)
	}
	if err := m.WriteFile(sid, "cfg/x", []byte("1"), 0); err != nil {
		t.Fatal(err)
	}
	if err := m.Rename(sid, "cfg/x", "cfg/old.properties"); errCode(err) != 409 {
		t.Fatalf("rename onto existing file: got %v", err)
	}
	if err := m.DeleteFiles(sid, []string{"cfg"}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(root, "cfg")); !os.IsNotExist(err) {
		t.Fatal("directory not deleted")
	}
	if err := m.DeleteFiles(sid, []string{"/"}); errCode(err) != 400 {
		t.Fatalf("deleting the root must be refused, got %v", err)
	}
}

func TestQuota(t *testing.T) {
	m, _ := newTestManager(t)
	if err := m.WriteFile(sid, "big", bytes.Repeat([]byte("x"), 900), 1000); err != nil {
		t.Fatal(err)
	}
	if err := m.WriteFile(sid, "more", bytes.Repeat([]byte("x"), 200), 1000); errCode(err) != 507 {
		t.Fatalf("expected 507 disk limit, got %v", err)
	}
}

func TestUploadAndAbort(t *testing.T) {
	m, root := newTestManager(t)
	recv := make(chan []byte, 4)
	recv <- []byte("hello ")
	recv <- []byte("world")
	close(recv)
	acks := 0
	if err := m.Upload(sid, "up/file.txt", 11, 0, recv, nil, func() error { acks++; return nil }); err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(filepath.Join(root, "up/file.txt"))
	if string(got) != "hello world" || acks != 2 {
		t.Fatalf("upload = %q, acks = %d", got, acks)
	}

	done := make(chan struct{})
	recv2 := make(chan []byte, 1)
	recv2 <- []byte("partial")
	go func() { close(done) }()
	_ = m.Upload(sid, "up/aborted.txt", 0, 0, recv2, done, func() error { return nil })
	entries, _ := os.ReadDir(filepath.Join(root, "up"))
	for _, e := range entries {
		if e.Name() != "file.txt" {
			t.Fatalf("aborted upload left %q behind", e.Name())
		}
	}
}

func TestCompressDecompressRoundtrip(t *testing.T) {
	m, root := newTestManager(t)
	_ = m.WriteFile(sid, "world/level.dat", []byte("level"), 0)
	_ = m.WriteFile(sid, ".hidden", []byte("h"), 0)
	archive, err := m.Compress(sid, "/", []string{"world", ".hidden"}, 0)
	if err != nil {
		t.Fatal(err)
	}
	_ = m.DeleteFiles(sid, []string{"world", ".hidden"})
	if err := m.Decompress(sid, "/", archive, 0); err != nil {
		t.Fatal(err)
	}
	for name, want := range map[string]string{"world/level.dat": "level", ".hidden": "h"} {
		got, err := os.ReadFile(filepath.Join(root, name))
		if err != nil || string(got) != want {
			t.Fatalf("%s = %q, %v", name, got, err)
		}
	}
}

func TestZipSlipAndBomb(t *testing.T) {
	m, root := newTestManager(t)
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	w, _ := zw.Create("../../escaped.txt")
	_, _ = w.Write([]byte("nope"))
	w, _ = zw.Create("big.bin")
	_, _ = w.Write(bytes.Repeat([]byte{0}, 5000))
	_ = zw.Close()
	if err := os.WriteFile(filepath.Join(root, "evil.zip"), buf.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}

	// Zip-slip: "../../escaped.txt" must land inside the root.
	parent := filepath.Dir(filepath.Dir(root))
	err := m.Decompress(sid, "/", "evil.zip", 4000)
	if _, statErr := os.Stat(filepath.Join(parent, "escaped.txt")); statErr == nil {
		t.Fatal("zip-slip wrote outside the server root")
	}
	if _, statErr := os.Stat(filepath.Join(root, "escaped.txt")); statErr != nil {
		t.Fatal("entry should have been extracted inside the root")
	}
	// Bomb: 5000 bytes do not fit into the remaining budget.
	if errCode(err) != 507 {
		t.Fatalf("expected 507 for oversized archive, got %v", err)
	}
}
