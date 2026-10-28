import { and, eq, isNull } from 'drizzle-orm'
import { z } from 'zod'

const params = z.object({ id: z.uuid() })

export default defineEventHandler(async (event) => {
  await requireAdminPermission(event, 'admin.nodes.write')
  const { id } = await getValidatedRouterParams(event, params.parse)

  const deleted = await useDb()
    .delete(schema.allocations)
    .where(and(eq(schema.allocations.id, id), isNull(schema.allocations.serverId)))
    .returning({ id: schema.allocations.id })
  if (deleted.length === 0) {
    throw createError({ statusCode: 409, statusMessage: 'allocation not found or assigned to a server' })
  }

  setResponseStatus(event, 204)
  return null
})
