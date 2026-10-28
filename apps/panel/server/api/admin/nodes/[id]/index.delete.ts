import { count, eq } from 'drizzle-orm'
import { z } from 'zod'

const params = z.object({ id: z.uuid() })

export default defineEventHandler(async (event) => {
  await requireAdminPermission(event, 'admin.nodes.write')
  const { id } = await getValidatedRouterParams(event, params.parse)
  const db = useDb()

  const [row] = await db.select({ n: count() }).from(schema.servers).where(eq(schema.servers.nodeId, id))
  if ((row?.n ?? 0) > 0) {
    throw createError({ statusCode: 409, statusMessage: 'node still has servers' })
  }

  const deleted = await db.delete(schema.nodes).where(eq(schema.nodes.id, id)).returning({ id: schema.nodes.id })
  if (deleted.length === 0) throw createError({ statusCode: 404, statusMessage: 'node not found' })

  getTunnel(id)?.peer.close(4005, 'node deleted')
  setResponseStatus(event, 204)
  return null
})
