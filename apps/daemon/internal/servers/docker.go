package servers

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"strconv"
	"strings"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/image"
	"github.com/docker/docker/api/types/network"
	"github.com/docker/docker/api/types/volume"
	"github.com/docker/docker/pkg/stdcopy"

	panelv1 "panel/daemon/internal/pb/panel/v1"
)

// DockerOverview lists containers, images, volumes and networks (read-only).
func (m *Manager) DockerOverview(ctx context.Context) (*panelv1.DockerOverviewResponse, error) {
	out := &panelv1.DockerOverviewResponse{}

	containers, err := m.docker.ContainerList(ctx, container.ListOptions{All: true})
	if err != nil {
		return nil, fmt.Errorf("list containers: %w", err)
	}
	for _, c := range containers {
		name := ""
		if len(c.Names) > 0 {
			name = strings.TrimPrefix(c.Names[0], "/")
		}
		ports := make([]string, 0, len(c.Ports))
		for _, p := range c.Ports {
			if p.PublicPort != 0 {
				ports = append(ports, fmt.Sprintf("%s:%d→%d/%s", p.IP, p.PublicPort, p.PrivatePort, p.Type))
			} else {
				ports = append(ports, fmt.Sprintf("%d/%s", p.PrivatePort, p.Type))
			}
		}
		out.Containers = append(out.Containers, &panelv1.DockerContainer{
			Id: c.ID, Name: name, Image: c.Image, State: c.State, Status: c.Status,
			CreatedUnix: c.Created, Ports: ports, Labels: c.Labels,
			Managed: c.Labels[labelManaged] == "true",
		})
	}

	images, err := m.docker.ImageList(ctx, image.ListOptions{All: false})
	if err != nil {
		return nil, fmt.Errorf("list images: %w", err)
	}
	for _, i := range images {
		out.Images = append(out.Images, &panelv1.DockerImage{
			Id: i.ID, Tags: i.RepoTags, SizeBytes: i.Size, CreatedUnix: i.Created, Containers: i.Containers,
		})
	}

	vols, err := m.docker.VolumeList(ctx, volume.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list volumes: %w", err)
	}
	for _, v := range vols.Volumes {
		out.Volumes = append(out.Volumes, &panelv1.DockerVolume{
			Name: v.Name, Driver: v.Driver, Mountpoint: v.Mountpoint, CreatedAt: v.CreatedAt,
		})
	}

	nets, err := m.docker.NetworkList(ctx, network.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("list networks: %w", err)
	}
	for _, n := range nets {
		out.Networks = append(out.Networks, &panelv1.DockerNetwork{
			Id: n.ID, Name: n.Name, Driver: n.Driver, Scope: n.Scope, Containers: uint32(len(n.Containers)),
		})
	}
	return out, nil
}

const maxLogBytes = 1 << 20

// ContainerLogs returns the last lines of any container's log.
func (m *Manager) ContainerLogs(ctx context.Context, id string, tail uint32) (string, error) {
	if tail == 0 || tail > 5000 {
		tail = 500
	}
	info, err := m.docker.ContainerInspect(ctx, id)
	if err != nil {
		return "", err
	}
	rc, err := m.docker.ContainerLogs(ctx, id, container.LogsOptions{
		ShowStdout: true, ShowStderr: true, Tail: strconv.Itoa(int(tail)),
	})
	if err != nil {
		return "", err
	}
	defer rc.Close()
	limited := io.LimitReader(rc, maxLogBytes)
	if info.Config != nil && info.Config.Tty {
		b, err := io.ReadAll(limited)
		return string(b), err
	}
	var buf bytes.Buffer
	_, err = stdcopy.StdCopy(&buf, &buf, limited)
	return buf.String(), err
}
