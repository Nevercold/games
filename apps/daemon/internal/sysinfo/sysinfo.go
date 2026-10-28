// Package sysinfo collects host information reported to the panel.
package sysinfo

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"os"
	"runtime"
	"time"
)

// Info is a snapshot of host facts sent in the tunnel handshake.
type Info struct {
	Hostname         string
	OS               string
	Arch             string
	Kernel           string
	MemoryTotalBytes uint64
	CPUCount         uint32
	DockerVersion    string
}

// Collect gathers host info. Missing values are left empty rather than
// failing: an unreachable Docker engine must not prevent the tunnel.
func Collect(ctx context.Context, dockerSocket string) Info {
	host, _ := os.Hostname()
	return Info{
		Hostname:         host,
		OS:               runtime.GOOS,
		Arch:             runtime.GOARCH,
		Kernel:           kernelVersion(),
		MemoryTotalBytes: memoryTotal(),
		CPUCount:         uint32(runtime.NumCPU()),
		DockerVersion:    dockerVersion(ctx, dockerSocket),
	}
}

// dockerVersion queries GET /version on the engine socket.
// lean-ctx: raw socket call, switch to the Docker SDK client in phase 2
func dockerVersion(ctx context.Context, socket string) string {
	client := &http.Client{
		Timeout: 3 * time.Second,
		Transport: &http.Transport{
			DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
				var d net.Dialer
				return d.DialContext(ctx, "unix", socket)
			},
		},
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://docker/version", nil)
	if err != nil {
		return ""
	}
	resp, err := client.Do(req)
	if err != nil {
		return ""
	}
	defer resp.Body.Close()
	var v struct {
		Version string `json:"Version"`
	}
	if resp.StatusCode != http.StatusOK || json.NewDecoder(resp.Body).Decode(&v) != nil {
		return ""
	}
	return v.Version
}
