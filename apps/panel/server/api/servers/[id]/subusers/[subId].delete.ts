import { and, eq } from 'drizzle-orm'
import { z } from 'zod'

const params = z.object({ id: z.uuid(), subId: z.uuid() })

export default defineEventHandler(async (event) => {
  const { id, subId } = await getValidatedRouterParams(event, params.parse)
  const { permissions } = await requireServerPermission(event, id, 'user.write')
  const db = useDb()

  const sub = await db.query.serverSubusers.findFirst({
    where: and(eq(schema.serverSubusers.id, subId), eq(schema.serverSubusers.serverId, id)),
  })
  if (!sub) throw createError({ statusCode: 404, statusMessage: 'subuser not found' })
  assertGrantable(permissions, sub.permissions)

  await db.delete(schema.serverSubusers).where(eq(schema.serverSubusers.id, subId))
  setResponseStatus(event, 204)
  return null
})
