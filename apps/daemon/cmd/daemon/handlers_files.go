package main

import (
	"context"
	"time"

	"google.golang.org/protobuf/proto"

	panelv1 "panel/daemon/internal/pb/panel/v1"
	"panel/daemon/internal/servers"
	"panel/daemon/internal/tunnel"
)

// fileHandlers serve the file manager and the admin Docker actions.
func fileHandlers(m *servers.Manager) map[string]tunnel.Handler {
	ok := &panelv1.FileOpResponse{}
	return map[string]tunnel.Handler{
		"rpc:files.list": tunnel.RPC(func(_ context.Context, req *panelv1.FileListRequest) (proto.Message, error) {
			entries, err := m.ListFiles(req.ServerId, req.Path)
			return &panelv1.FileListResponse{Entries: entries}, err
		}),
		"rpc:files.read": tunnel.RPC(func(_ context.Context, req *panelv1.FileReadRequest) (proto.Message, error) {
			data, size, truncated, err := m.ReadFile(req.ServerId, req.Path, req.MaxBytes)
			return &panelv1.FileReadResponse{Content: data, Size: size, Truncated: truncated}, err
		}),
		"rpc:files.write": tunnel.RPC(func(_ context.Context, req *panelv1.FileWriteRequest) (proto.Message, error) {
			return ok, m.WriteFile(req.ServerId, req.Path, req.Content, req.DiskLimitBytes)
		}),
		"rpc:files.mkdir": tunnel.RPC(func(_ context.Context, req *panelv1.FileMkdirRequest) (proto.Message, error) {
			return ok, m.Mkdir(req.ServerId, req.Path)
		}),
		"rpc:files.rename": tunnel.RPC(func(_ context.Context, req *panelv1.FileRenameRequest) (proto.Message, error) {
			return ok, m.Rename(req.ServerId, req.From, req.To)
		}),
		"rpc:files.delete": tunnel.RPC(func(_ context.Context, req *panelv1.FileDeleteRequest) (proto.Message, error) {
			return ok, m.DeleteFiles(req.ServerId, req.Paths)
		}),
		"rpc:files.compress": tunnel.RPC(func(_ context.Context, req *panelv1.FileCompressRequest) (proto.Message, error) {
			archive, err := m.Compress(req.ServerId, req.Root, req.Paths, req.DiskLimitBytes)
			return &panelv1.FileCompressResponse{Archive: archive}, err
		}),
		"rpc:files.decompress": tunnel.RPC(func(_ context.Context, req *panelv1.FileDecompressRequest) (proto.Message, error) {
			return ok, m.Decompress(req.ServerId, req.Root, req.Archive, req.DiskLimitBytes)
		}),

		"file.download": func(_ context.Context, s *tunnel.Stream) error {
			var open panelv1.FileTransferOpen
			if err := proto.Unmarshal(s.Header, &open); err != nil {
				return tunnel.BadRequest("malformed request")
			}
			return m.Download(open.ServerId, open.Path, s.Send)
		},
		"file.upload": func(ctx context.Context, s *tunnel.Stream) error {
			var open panelv1.FileTransferOpen
			if err := proto.Unmarshal(s.Header, &open); err != nil {
				return tunnel.BadRequest("malformed request")
			}
			ack := func() error { return s.Send([]byte{}) }
			if err := m.Upload(open.ServerId, open.Path, open.Size, open.DiskLimitBytes, s.Recv(), ctx.Done(), ack); err != nil {
				return err
			}
			data, _ := proto.Marshal(ok)
			return s.Reply(data)
		},

		"rpc:docker.container": tunnel.RPC(func(ctx context.Context, req *panelv1.ContainerActionRequest) (proto.Message, error) {
			return ok, m.ContainerAction(ctx, req.ContainerId, req.Action)
		}),
		"rpc:docker.image.pull": tunnel.RPC(func(ctx context.Context, req *panelv1.ImagePullRequest) (proto.Message, error) {
			ctx, cancel := context.WithTimeout(ctx, 30*time.Minute)
			defer cancel()
			return ok, m.PullImage(ctx, req.Ref)
		}),
		"rpc:docker.image.remove": tunnel.RPC(func(ctx context.Context, req *panelv1.ImageRemoveRequest) (proto.Message, error) {
			return ok, m.RemoveImage(ctx, req.Id, req.Force)
		}),
		"docker.exec": func(ctx context.Context, s *tunnel.Stream) error {
			var open panelv1.ExecOpen
			if err := proto.Unmarshal(s.Header, &open); err != nil {
				return tunnel.BadRequest("malformed request")
			}
			return m.Exec(ctx, &open, s.Recv(), s.Send)
		},
		"rpc:docker.volume.list": tunnel.RPC(func(ctx context.Context, req *panelv1.VolumeListRequest) (proto.Message, error) {
			entries, err := m.ListVolume(ctx, req.Volume, req.Path)
			return &panelv1.FileListResponse{Entries: entries}, err
		}),
		"rpc:docker.volume.read": tunnel.RPC(func(ctx context.Context, req *panelv1.VolumeReadRequest) (proto.Message, error) {
			data, truncated, err := m.ReadVolumeFile(ctx, req.Volume, req.Path, req.MaxBytes)
			return &panelv1.FileReadResponse{Content: data, Size: uint64(len(data)), Truncated: truncated}, err
		}),
	}
}
