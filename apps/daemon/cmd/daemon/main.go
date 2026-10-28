// Command daemon is the node agent. It connects outbound to the panel and
// manages Docker workloads on this host.
package main

import (
	"context"
	"flag"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/docker/docker/client"

	"panel/daemon/internal/config"
	"panel/daemon/internal/servers"
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

	log.Info("starting daemon", "version", version, "panel", tunnelURL)
	client := tunnel.New(tunnel.Options{
		URL:           tunnelURL,
		Token:         cfg.Token,
		DaemonVersion: version,
		DockerSocket:  cfg.DockerSocket,
		Logger:        log,
		Handlers:      handlers(mgr),
	})
	mgr.SetEmitter(client.Emit)

	if err := client.Run(ctx); err != nil {
		return err
	}
	log.Info("daemon stopped")
	return nil
}
