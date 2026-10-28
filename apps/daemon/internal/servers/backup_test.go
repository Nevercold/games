package servers

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
	"time"

	panelv1 "panel/daemon/internal/pb/panel/v1"
)

func waitBackupEvent(t *testing.T, ch <-chan *panelv1.BackupFinished) *panelv1.BackupFinished {
	t.Helper()
	select {
	case e := <-ch:
		return e
	case <-time.After(20 * time.Second):
		t.Fatal("no BackupFinished event")
		return nil
	}
}

func TestBackupRoundTrip(t *testing.T) {
	m, root := newTestManager(t)
	events := make(chan *panelv1.BackupFinished, 4)
	m.SetEmitter(func(e *panelv1.Event) {
		if b := e.GetBackupFinished(); b != nil {
			events <- b
		}
	})

	big := bytes.Repeat([]byte("panel"), 300_000)
	files := map[string][]byte{
		"server.properties":    []byte("motd=hi\n"),
		"world/level.dat":      big,
		"logs/latest.log":      []byte("noise"),
		"cache/x/y.bin":        []byte("cache"),
		"plugins/a/config.yml": []byte("a: 1"),
		"plugins/a/debug.tmp":  []byte("tmp"),
		"nested/logs/keep.txt": []byte("anchored rule must not hit this"),
	}
	for p, c := range files {
		full := filepath.Join(root, p)
		_ = os.MkdirAll(filepath.Dir(full), 0o755)
		if err := os.WriteFile(full, c, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	target := &panelv1.BackupTarget{Type: "local"}
	key := sid + "/b1.tar.zst"
	err := m.CreateBackup(&panelv1.BackupCreateRequest{
		ServerId: sid, BackupId: "b1", Target: target, Key: key,
		Ignore: []string{"/logs", "cache/", "*.tmp", "# comment"},
	})
	if err != nil {
		t.Fatal(err)
	}
	ev := waitBackupEvent(t, events)
	if !ev.Success || ev.SizeBytes == 0 || len(ev.Sha256) != 64 {
		t.Fatalf("backup event: %+v", ev)
	}
	if ev.SizeBytes > uint64(len(big))/10 {
		t.Errorf("archive not compressed: %d bytes", ev.SizeBytes)
	}
	if _, err := os.Stat(filepath.Join(m.BackupDir(), sid, "b1.tar.zst")); err != nil {
		t.Fatal("archive missing in backup dir:", err)
	}

	// Mess up the server, then restore with truncate.
	_ = os.WriteFile(filepath.Join(root, "server.properties"), []byte("broken"), 0o644)
	_ = os.WriteFile(filepath.Join(root, "new-file.txt"), []byte("gone after truncate"), 0o644)
	_ = os.RemoveAll(filepath.Join(root, "world"))

	err = m.RestoreBackup(&panelv1.BackupRestoreRequest{ServerId: sid, BackupId: "b1", Target: target, Key: key, Truncate: true, Sha256: ev.Sha256})
	if err != nil {
		t.Fatal(err)
	}
	if ev := waitBackupEvent(t, events); !ev.Success || !ev.Restore {
		t.Fatalf("restore event: %+v", ev)
	}
	for p, want := range map[string][]byte{"server.properties": []byte("motd=hi\n"), "world/level.dat": big, "plugins/a/config.yml": []byte("a: 1"), "nested/logs/keep.txt": files["nested/logs/keep.txt"]} {
		got, err := os.ReadFile(filepath.Join(root, p))
		if err != nil || !bytes.Equal(got, want) {
			t.Errorf("%s not restored (err=%v)", p, err)
		}
	}
	for _, p := range []string{"logs/latest.log", "cache/x/y.bin", "plugins/a/debug.tmp", "new-file.txt"} {
		if _, err := os.Stat(filepath.Join(root, p)); err == nil {
			t.Errorf("%s should not exist after restore", p)
		}
	}

	// Wrong checksum is reported as failure.
	if err := m.RestoreBackup(&panelv1.BackupRestoreRequest{ServerId: sid, BackupId: "b1", Target: target, Key: key, Sha256: "00"}); err != nil {
		t.Fatal(err)
	}
	if ev := waitBackupEvent(t, events); ev.Success {
		t.Error("checksum mismatch not detected")
	}

	// Restore refused while running; start refused while restoring.
	s, _ := m.server(sid)
	s.mu.Lock()
	s.state = panelv1.ServerState_SERVER_STATE_RUNNING
	s.mu.Unlock()
	if err := m.RestoreBackup(&panelv1.BackupRestoreRequest{ServerId: sid, Target: target, Key: key}); errCode(err) != 409 {
		t.Errorf("restore of running server: %v", err)
	}
	s.mu.Lock()
	s.state = panelv1.ServerState_SERVER_STATE_OFFLINE
	s.restoring = true
	s.mu.Unlock()
	if err := m.Start(&panelv1.ServerSpec{Id: sid, Image: "x"}); errCode(err) != 409 {
		t.Errorf("start during restore: %v", err)
	}
}

func TestBackupKeyValidation(t *testing.T) {
	m, _ := newTestManager(t)
	for _, key := range []string{"../escape.tar.zst", "/abs", "a/../b", "", "a//b"} {
		err := m.CreateBackup(&panelv1.BackupCreateRequest{ServerId: sid, Target: &panelv1.BackupTarget{Type: "local"}, Key: key})
		if errCode(err) != 400 {
			t.Errorf("key %q: %v", key, err)
		}
	}
	err := m.CreateBackup(&panelv1.BackupCreateRequest{ServerId: sid, Target: &panelv1.BackupTarget{Type: "local", Config: []byte(`{"subdir":"../x"}`)}, Key: "k"})
	if errCode(err) != 400 {
		t.Errorf("subdir traversal: %v", err)
	}
	err = m.CreateBackup(&panelv1.BackupCreateRequest{ServerId: sid, Target: &panelv1.BackupTarget{Type: "nfs"}, Key: "k"})
	if errCode(err) != 400 {
		t.Errorf("unknown type: %v", err)
	}
}

func TestIgnoreMatcher(t *testing.T) {
	match := newIgnoreMatcher([]string{"/logs", "cache/", "*.tmp", "plugins/*/data", "!keep"})
	cases := map[string]struct {
		dir  bool
		want bool
	}{
		"logs":               {true, true},
		"sub/logs":           {true, false},
		"cache":              {true, true},
		"a/cache":            {true, true},
		"cache.txt":          {false, false},
		"x/y/z.tmp":          {false, true},
		"plugins/foo/data":   {true, true},
		"plugins/foo/config": {true, false},
		"keep":               {false, false},
	}
	for p, c := range cases {
		if got := match(p, c.dir); got != c.want {
			t.Errorf("%s: got %v want %v", p, got, c.want)
		}
	}
}
