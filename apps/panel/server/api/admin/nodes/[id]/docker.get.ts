import { DockerOverviewRequestSchema, DockerOverviewResponseSchema } from '@panel/protocol'
import { eq } from 'drizzle-orm'
import { z } from 'zod'

const params = z.object({ id: z.uuid() })

/** Read-only Docker overview of a node (Portainer direction, PLAN.md). */
export default defineEventHandler(async (event) => {
  await requireAdminPermission(event, 'admin.docker.read')
  const { id } = await getValidatedRouterParams(event, params.parse)
  const node = await useDb().query.nodes.findFirst({ where: eq(schema.nodes.id, id), columns: { dockerManagement: true } })
  if (!node) throw createError({ statusCode: 404, statusMessage: 'node not found' })
  if (!node.dockerManagement) throw createError({ statusCode: 403, statusMessage: 'docker management is disabled on this node' })

  let res
  try {
    res = await rpc(id, 'docker.overview', DockerOverviewRequestSchema, {}, DockerOverviewResponseSchema, 20_000)
  } catch (err) {
    throw toHttpError(err)
  }
  return {
    containers: res.containers.map((c) => ({
      id: c.id,
      name: c.name,
      image: c.image,
      state: c.state,
      status: c.status,
      created: Number(c.createdUnix),
      ports: c.ports,
      managed: c.managed,
      serverId: c.labels['panel.server'] ?? null,
    })),
    images: res.images.map((i) => ({ id: i.id, tags: i.tags, size: Number(i.sizeBytes), created: Number(i.createdUnix), containers: Number(i.containers) })),
    volumes: res.volumes.map((v) => ({ name: v.name, driver: v.driver, mountpoint: v.mountpoint, createdAt: v.createdAt })),
    networks: res.networks.map((n) => ({ id: n.id, name: n.name, driver: n.driver, scope: n.scope, containers: n.containers })),
  }
})
