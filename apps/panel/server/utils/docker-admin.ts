import { eq } from 'drizzle-orm'
import type { H3Event } from 'h3'
import type { AdminPermission } from '#shared/permissions'

/** Loads a node for the Docker area and checks that it allows Docker management. */
export async function requireDockerNode(event: H3Event, permission: AdminPermission) {
  const actor = await requireAdminPermission(event, permission)
  const id = getRouterParam(event, 'id') ?? ''
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw createError({ statusCode: 400, statusMessage: 'invalid node id' })
  const node = await useDb().query.nodes.findFirst({ where: eq(schema.nodes.id, id), columns: { id: true, dockerManagement: true } })
  if (!node) throw createError({ statusCode: 404, statusMessage: 'node not found' })
  if (!node.dockerManagement) throw createError({ statusCode: 403, statusMessage: 'docker management is disabled on this node' })
  return { actor, nodeId: node.id }
}
