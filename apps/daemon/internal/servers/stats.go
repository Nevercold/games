package servers

import (
	"context"
	"encoding/json"
	"io/fs"
	"path/filepath"
	"time"

	"github.com/docker/docker/api/types/container"

	panelv1 "panel/daemon/internal/pb/panel/v1"
)

const (
	statsInterval = 2 * time.Second
	diskCacheTTL  = 30 * time.Second
)

// StreamStats sends a sample every few seconds until ctx is done.
func (m *Manager) StreamStats(ctx context.Context, id string, send func(*panelv1.StatsSample) error) error {
	s, err := m.server(id)
	if err != nil {
		return err
	}
	t := time.NewTicker(statsInterval)
	defer t.Stop()
	for {
		sample := s.sample(ctx)
		if err := send(sample); err != nil {
			return err
		}
		select {
		case <-ctx.Done():
			return nil
		case <-t.C:
		}
	}
}

func (s *Server) sample(ctx context.Context) *panelv1.StatsSample {
	s.mu.Lock()
	state, started, running := s.state, s.startedAt, s.exited != nil
	s.mu.Unlock()

	out := &panelv1.StatsSample{State: state, DiskBytes: s.disk()}
	if !running {
		return out
	}
	out.UptimeMs = time.Since(started).Milliseconds()

	sctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	resp, err := s.m.docker.ContainerStats(sctx, containerName(s.id), false)
	if err != nil {
		return out
	}
	defer resp.Body.Close()
	var st container.StatsResponse
	if json.NewDecoder(resp.Body).Decode(&st) != nil {
		return out
	}

	cpuDelta := float64(st.CPUStats.CPUUsage.TotalUsage) - float64(st.PreCPUStats.CPUUsage.TotalUsage)
	sysDelta := float64(st.CPUStats.SystemUsage) - float64(st.PreCPUStats.SystemUsage)
	cpus := float64(st.CPUStats.OnlineCPUs)
	if cpus == 0 {
		cpus = float64(len(st.CPUStats.CPUUsage.PercpuUsage))
	}
	if cpuDelta > 0 && sysDelta > 0 {
		out.CpuPercent = cpuDelta / sysDelta * cpus * 100
	}

	// Report the working set like `docker stats` (usage minus page cache).
	mem := st.MemoryStats.Usage
	if inactive, ok := st.MemoryStats.Stats["inactive_file"]; ok && inactive < mem {
		mem -= inactive
	}
	out.MemoryBytes = mem
	out.MemoryLimitBytes = st.MemoryStats.Limit
	for _, n := range st.Networks {
		out.NetRxBytes += n.RxBytes
		out.NetTxBytes += n.TxBytes
	}
	return out
}

// disk returns the server directory size, recomputed at most every 30s.
func (s *Server) disk() uint64 {
	s.diskMu.Lock()
	defer s.diskMu.Unlock()
	if time.Since(s.diskAt) < diskCacheTTL {
		return s.diskBytes
	}
	var total uint64
	_ = filepath.WalkDir(s.m.serverDir(s.id), func(_ string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		if info, err := d.Info(); err == nil {
			total += uint64(info.Size())
		}
		return nil
	})
	s.diskBytes, s.diskAt = total, time.Now()
	return total
}
