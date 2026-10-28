import { asc, eq } from 'drizzle-orm'
import { z } from 'zod'

const params = z.object({ id: z.uuid() })

export default defineEventHandler(async (event) => {
  await requireAdminPermission(event, 'admin.nodes.read')
  const { id } = await getValidatedRouterParams(event, params.parse)

  const node = await useDb().query.nodes.findFirst({
    where: eq(schema.nodes.id, id),
    columns: { tokenHash: false },
    with: {
      allocations: { orderBy: [asc(schema.allocations.ip), asc(schema.allocations.port)] },
      servers: { columns: { id: true, name: true, status: true } },
    },
  })
  if (!node) throw createError({ statusCode: 404, statusMessage: 'node not found' })

  const tunnel = getTunnel(id)
  return {
    ...node,
    online: isNodeOnline(id),
    connectedAt: tunnel?.ready ? tunnel.connectedAt : null,
  }
})
