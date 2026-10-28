import { ContainerLogsRequestSchema, ContainerLogsResponseSchema } from '@panel/protocol'
import { eq } from 'drizzle-orm'
import { z } from 'zod'

const params = z.object({ id: z.uuid() })
const query = z.object({
  container: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/),
  tail: z.coerce.number().int().min(1).max(5000).default(500),
})

export default defineEventHandler(async (event) => {
  await requireAdminPermission(event, 'admin.docker.read')
  const { id } = await getValidatedRouterParams(event, params.parse)
  const { container, tail } = await getValidatedQuery(event, query.parse)
  const node = await useDb().query.nodes.findFirst({ where: eq(schema.nodes.id, id), columns: { dockerManagement: true } })
  if (!node) throw createError({ statusCode: 404, statusMessage: 'node not found' })
  if (!node.dockerManagement) throw createError({ statusCode: 403, statusMessage: 'docker management is disabled on this node' })
  try {
    const res = await rpc(id, 'docker.logs', ContainerLogsRequestSchema, { containerId: container, tail }, ContainerLogsResponseSchema, 20_000)
    return { logs: res.logs }
  } catch (err) {
    throw toHttpError(err)
  }
})
