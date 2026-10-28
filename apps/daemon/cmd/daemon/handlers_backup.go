package main

import (
	"context"
	"errors"
	"io"
	"time"

	"google.golang.org/protobuf/proto"

	"panel/daemon/internal/backup"
	panelv1 "panel/daemon/internal/pb/panel/v1"
	"panel/daemon/internal/servers"
	"panel/daemon/internal/tunnel"
)

// downloadWindow is the number of chunks in flight before the panel must ack.
const downloadWindow = 16

// backupHandlers create, restore, delete and stream backups.
func backupHandlers(m *servers.Manager) map[string]tunnel.Handler {
	return map[string]tunnel.Handler{
		"rpc:backup.create": tunnel.RPC(func(_ context.Context, req *panelv1.BackupCreateRequest) (proto.Message, error) {
			return &panelv1.BackupCreateResponse{}, m.CreateBackup(req)
		}),
		"rpc:backup.restore": tunnel.RPC(func(_ context.Context, req *panelv1.BackupRestoreRequest) (proto.Message, error) {
			return &panelv1.BackupRestoreResponse{}, m.RestoreBackup(req)
		}),
		"rpc:backup.delete": tunnel.RPC(func(ctx context.Context, req *panelv1.BackupDeleteRequest) (proto.Message, error) {
			ctx, cancel := context.WithTimeout(ctx, time.Minute)
			defer cancel()
			store, err := backup.Open(ctx, req.Target, m.BackupDir())
			if err != nil {
				return nil, err
			}
			defer store.Close()
			return &panelv1.BackupDeleteResponse{}, store.Delete(ctx, req.Key)
		}),
		"rpc:backup.test": tunnel.RPC(func(ctx context.Context, req *panelv1.BackupTestRequest) (proto.Message, error) {
			ctx, cancel := context.WithTimeout(ctx, time.Minute)
			defer cancel()
			fp, err := backup.Test(ctx, req.Target, m.BackupDir())
			if err != nil {
				var te *tunnel.Error
				switch {
				case errors.As(err, &te) && te.Code == 412:
					// Unpinned SFTP host key: report the fingerprint so the
					// admin can confirm it; nothing else was tested yet.
					return &panelv1.BackupTestResponse{HostKeyFingerprint: fp}, nil
				case !errors.As(err, &te):
					err = &tunnel.Error{Code: 502, Message: err.Error()}
				}
			}
			return &panelv1.BackupTestResponse{HostKeyFingerprint: fp}, err
		}),
		"backup.download": func(ctx context.Context, s *tunnel.Stream) error {
			var open panelv1.BackupDownloadOpen
			if err := proto.Unmarshal(s.Header, &open); err != nil {
				return tunnel.BadRequest("malformed request")
			}
			store, err := backup.Open(ctx, open.Target, m.BackupDir())
			if err != nil {
				return err
			}
			defer store.Close()
			rc, err := store.Get(ctx, open.Key)
			if err != nil {
				return err
			}
			defer rc.Close()
			// Credit-based flow control: every (empty) frame from the panel
			// grants one more chunk, so a slow browser never makes the panel
			// buffer a multi-GB archive in memory.
			credits := downloadWindow
			buf := make([]byte, 256<<10)
			for {
				for credits == 0 {
					select {
					case _, ok := <-s.Recv():
						if !ok {
							return errors.New("download aborted")
						}
						credits++
					case <-ctx.Done():
						return ctx.Err()
					}
				}
				n, err := rc.Read(buf)
				if n > 0 {
					if err := s.Send(append([]byte(nil), buf[:n]...)); err != nil {
						return err
					}
					credits--
				}
				if errors.Is(err, io.EOF) {
					return nil
				}
				if err != nil {
					return err
				}
			}
		},
	}
}
