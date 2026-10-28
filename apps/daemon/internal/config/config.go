// Package config loads and validates the daemon configuration file.
package config

import (
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"strings"

	"gopkg.in/yaml.v3"
)

// Config is the on-disk daemon configuration (config.yaml).
type Config struct {
	// PanelURL is the panel base URL, e.g. https://panel.example.com.
	PanelURL string `yaml:"panel_url"`
	// Token is the node token "<nodeId>.<secret>" shown once in the panel.
	Token string `yaml:"token"`
	// DataDir holds server volumes and daemon state.
	DataDir string `yaml:"data_dir"`
	// AllowInsecure permits plain ws:// to non-loopback panels (dev/LAN only).
	AllowInsecure bool `yaml:"allow_insecure"`
	// DockerSocket is the path of the Docker engine unix socket.
	DockerSocket string `yaml:"docker_socket"`
	// LogLevel is one of debug, info, warn, error.
	LogLevel string `yaml:"log_level"`
	// ContainerUser is "uid:gid" game containers run as (Wings default 988:988).
	// Server files are chowned to it on Linux.
	ContainerUser string `yaml:"container_user"`
	// StopTimeoutS is how long a stop may take before the container is killed.
	StopTimeoutS int `yaml:"stop_timeout_s"`
	// SFTP configures the built-in SFTP server.
	SFTP SFTPConfig `yaml:"sftp"`
}

// SFTPConfig of the built-in server; logins are checked by the panel.
type SFTPConfig struct {
	Enabled bool   `yaml:"enabled"`
	Bind    string `yaml:"bind"`
}

// Load reads and validates the config file at path.
func Load(path string) (*Config, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read config: %w", err)
	}
	cfg := &Config{
		DataDir:       "/var/lib/panel-daemon",
		DockerSocket:  "/var/run/docker.sock",
		LogLevel:      "info",
		ContainerUser: "988:988",
		StopTimeoutS:  120,
		SFTP:          SFTPConfig{Enabled: true, Bind: "0.0.0.0:2022"},
	}
	if err := yaml.Unmarshal(raw, cfg); err != nil {
		return nil, fmt.Errorf("parse config: %w", err)
	}
	if err := cfg.validate(); err != nil {
		return nil, fmt.Errorf("invalid config: %w", err)
	}
	return cfg, nil
}

func (c *Config) validate() error {
	if c.PanelURL == "" {
		return errors.New("panel_url is required")
	}
	if c.Token == "" {
		return errors.New("token is required")
	}
	if i := strings.IndexByte(c.Token, '.'); i <= 0 || i == len(c.Token)-1 {
		return errors.New("token must have the form <nodeId>.<secret>")
	}
	_, err := c.TunnelURL()
	return err
}

// TunnelURL derives the websocket endpoint from PanelURL.
// https → wss is always allowed; http → ws only for loopback hosts or when
// AllowInsecure is set, because the node token travels in the handshake.
func (c *Config) TunnelURL() (string, error) {
	u, err := url.Parse(strings.TrimRight(c.PanelURL, "/"))
	if err != nil {
		return "", fmt.Errorf("panel_url: %w", err)
	}
	switch u.Scheme {
	case "https":
		u.Scheme = "wss"
	case "http":
		if !c.AllowInsecure && !isLoopback(u.Hostname()) {
			return "", errors.New("panel_url uses http to a non-loopback host; use https or set allow_insecure: true")
		}
		u.Scheme = "ws"
	default:
		return "", fmt.Errorf("panel_url: unsupported scheme %q", u.Scheme)
	}
	u.Path += "/api/nodes/tunnel"
	return u.String(), nil
}

func isLoopback(host string) bool {
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}
