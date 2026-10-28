import { and, eq } from 'drizzle-orm'
import { z } from 'zod'

const params = z.object({ id: z.uuid(), subId: z.uuid() })
const bodySchema = z.object({ permissions: subuserPermissionsSchema })

export default defineEventHandler(async (event) => {
  const { id, subId } = await getValidatedRouterParams(event, params.parse)
  const body = await readValidatedBody(event, bodySchema.parse)
  const { permissions, actor } = await requireServerPermission(event, id, 'user.write')
  assertGrantable(permissions, body.permissions)

  const db = useDb()
  const sub = await db.query.serverSubusers.findFirst({
    where: and(eq(schema.serverSubusers.id, subId), eq(schema.serverSubusers.serverId, id)),
  })
  if (!sub) throw createError({ statusCode: 404, statusMessage: 'subuser not found' })
  if (sub.userId === actor.id) throw createError({ statusCode: 403, statusMessage: 'cannot change your own permissions' })
  // A subuser must not strip rights they could not grant (e.g. from a peer with more rights).
  assertGrantable(permissions, sub.permissions)

  await db.update(schema.serverSubusers).set({ permissions: body.permissions }).where(eq(schema.serverSubusers.id, subId))
  return { ok: true }
})
