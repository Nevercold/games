package main

import (
	"context"

	"google.golang.org/protobuf/proto"

	panelv1 "panel/daemon/internal/pb/panel/v1"
	"panel/daemon/internal/servers"
	"panel/daemon/internal/tunnel"
)

// handlers maps stream kinds to their implementation.
func handlers(m *servers.Manager) map[string]tunnel.Handler {
	return map[string]tunnel.Handler{
		"rpc:power": tunnel.RPC(func(_ context.Context, req *panelv1.PowerRequest) (proto.Message, error) {
			var err error
			switch req.Action {
			case panelv1.PowerAction_POWER_ACTION_START:
				err = m.Start(req.Spec)
			case panelv1.PowerAction_POWER_ACTION_STOP:
				err = m.Stop(serverID(req.Spec))
			case panelv1.PowerAction_POWER_ACTION_RESTART:
				err = m.Restart(req.Spec)
			case panelv1.PowerAction_POWER_ACTION_KILL:
				err = m.Kill(serverID(req.Spec))
			default:
				err = tunnel.BadRequest("unknown power action")
			}
			return &panelv1.PowerResponse{}, err
		}),

		"rpc:install": tunnel.RPC(func(_ context.Context, req *panelv1.InstallRequest) (proto.Message, error) {
			return &panelv1.InstallResponse{}, m.Install(req.Spec, req.Install)
		}),

		"rpc:delete": tunnel.RPC(func(_ context.Context, req *panelv1.DeleteServerRequest) (proto.Message, error) {
			return &panelv1.DeleteServerResponse{}, m.Delete(req.ServerId, req.DeleteFiles)
		}),

		"rpc:states": tunnel.RPC(func(_ context.Context, req *panelv1.ServerStatesRequest) (proto.Message, error) {
			return &panelv1.ServerStatesResponse{States: m.States(req.ServerIds)}, nil
		}),

		"rpc:docker.overview": tunnel.RPC(func(ctx context.Context, _ *panelv1.DockerOverviewRequest) (proto.Message, error) {
			return m.DockerOverview(ctx)
		}),

		"rpc:docker.logs": tunnel.RPC(func(ctx context.Context, req *panelv1.ContainerLogsRequest) (proto.Message, error) {
			logs, err := m.ContainerLogs(ctx, req.ContainerId, req.Tail)
			if err != nil {
				return nil, tunnel.NotFound(err.Error())
			}
			return &panelv1.ContainerLogsResponse{Logs: logs}, nil
		}),

		// console: history + live output to the panel, panel data = commands.
		"console": func(ctx context.Context, s *tunnel.Stream) error {
			var open panelv1.ConsoleOpen
			if err := proto.Unmarshal(s.Header, &open); err != nil {
				return tunnel.BadRequest("malformed console request")
			}
			con, err := m.Console(open.ServerId)
			if err != nil {
				return err
			}
			history, out, cancel := con.Subscribe()
			defer cancel()
			if len(history) > 0 {
				if err := s.Send(history); err != nil {
					return err
				}
			}
			in := s.Recv()
			for {
				select {
				case <-ctx.Done():
					return nil
				case chunk, ok := <-out:
					if !ok {
						return nil
					}
					if err := s.Send(chunk); err != nil {
						return err
					}
				case line, ok := <-in:
					if !ok {
						in = nil // panel finished sending; keep streaming output
						continue
					}
					if err := m.SendCommand(open.ServerId, string(line)); err != nil {
						con.System("Command not sent: " + err.Error())
					}
				}
			}
		},

		"stats": func(ctx context.Context, s *tunnel.Stream) error {
			var open panelv1.StatsOpen
			if err := proto.Unmarshal(s.Header, &open); err != nil {
				return tunnel.BadRequest("malformed stats request")
			}
			return m.StreamStats(ctx, open.ServerId, func(sample *panelv1.StatsSample) error {
				data, err := proto.Marshal(sample)
				if err != nil {
					return err
				}
				return s.Send(data)
			})
		},
	}
}

func serverID(spec *panelv1.ServerSpec) string {
	if spec == nil {
		return ""
	}
	return spec.Id
}
