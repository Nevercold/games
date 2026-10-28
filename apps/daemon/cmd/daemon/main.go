// Command daemon is the node agent. It connects outbound to the panel and
// manages Docker workloads on this host.
package main

import (
	"context"
	"flag"
	"fmt"
	"log/slog"
	"maps"
	"net"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"syscall"
	"time"

	"github.com/docker/docker/client"

	"panel/daemon/internal/config"
	panelv1 "panel/daemon/internal/pb/panel/v1"
	"panel/daemon/internal/servers"
	"panel/daemon/internal/sftpd"
	"panel/daemon/internal/tunnel"
)

// version is set at build time via -ldflags "-X main.version=…".
var version = "dev"

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}

func run() error {
	configPath := flag.String("config", "config.yaml", "path to config file")
	showVersion := flag.Bool("version", false, "print version and exit")
	flag.Parse()

	if *showVersion {
		fmt.Println(version)
		return nil
	}

	cfg, err := config.Load(*configPath)
	if err != nil {
		return err
	}

	var level slog.Level
	if err := level.UnmarshalText([]byte(cfg.LogLevel)); err != nil {
		return fmt.Errorf("log_level: %w", err)
	}
	log := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: level}))

	tunnelURL, err := cfg.TunnelURL()
	if err != nil {
		return err
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	docker, err := client.NewClientWithOpts(
		client.WithHost("unix://"+cfg.DockerSocket),
		client.WithAPIVersionNegotiation(),
	)
	if err != nil {
		return fmt.Errorf("docker client: %w", err)
	}
	defer docker.Close()

	mgr, err := servers.NewManager(servers.Options{
		Docker:        docker,
		DataDir:       cfg.DataDir,
		ContainerUser: cfg.ContainerUser,
		StopTimeout:   time.Duration(cfg.StopTimeoutS) * time.Second,
		Logger:        log,
	})
	if err != nil {
		return err
	}
	if err := mgr.Recover(ctx); err != nil {
		log.Warn("could not recover running servers (is Docker reachable?)", "err", err)
	}

	var sftpPort uint32
	if cfg.SFTP.Enabled {
		_, portStr, err := net.SplitHostPort(cfg.SFTP.Bind)
		if err != nil {
			return fmt.Errorf("sftp.bind: %w", err)
		}
		p, err := strconv.ParseUint(portStr, 10, 16)
		if err != nil {
			return fmt.Errorf("sftp.bind: %w", err)
		}
		sftpPort = uint32(p)
	}

	all := handlers(mgr)
	maps.Copy(all, fileHandlers(mgr))

	log.Info("starting daemon", "version", version, "panel", tunnelURL)
	client := tunnel.New(tunnel.Options{
		URL:           tunnelURL,
		Token:         cfg.Token,
		DaemonVersion: version,
		DockerSocket:  cfg.DockerSocket,
		SftpPort:      sftpPort,
		Logger:        log,
		Handlers:      all,
	})
	mgr.SetEmitter(client.Emit)

	if cfg.SFTP.Enabled {
		srv := &sftpd.Server{
			Addr:        cfg.SFTP.Bind,
			HostKeyPath: filepath.Join(cfg.DataDir, ".state", "sftp_host_ed25519"),
			Backend:     mgr,
			Log:         log.With("component", "sftp"),
			Auth: func(ctx context.Context, username, password, ip string) (*sftpd.Grant, error) {
				var res panelv1.SftpAuthResponse
				if err := client.Call(ctx, "sftp.auth", &panelv1.SftpAuthRequest{Username: username, Password: password, RemoteIp: ip}, &res); err != nil {
					return nil, err
				}
				perms := make(map[string]bool, len(res.Permissions))
				for _, p := range res.Permissions {
					perms[p] = true
				}
				return &sftpd.Grant{ServerID: res.ServerId, Permissions: perms, DiskLimit: res.DiskLimitBytes}, nil
			},
		}
		go func() {
			if err := srv.Run(ctx); err != nil {
				log.Error("sftp server stopped", "err", err)
			}
		}()
	}

	if err := client.Run(ctx); err != nil {
		return err
	}
	log.Info("daemon stopped")
	return nil
}
