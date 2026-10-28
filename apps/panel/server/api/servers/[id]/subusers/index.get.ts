import { asc, eq } from 'drizzle-orm'
import { z } from 'zod'

const params = z.object({ id: z.uuid() })

export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, params.parse)
  await requireServerPermission(event, id, 'user.read')
  return useDb()
    .select({
      id: schema.serverSubusers.id,
      userId: schema.users.id,
      username: schema.users.username,
      email: schema.users.email,
      permissions: schema.serverSubusers.permissions,
      createdAt: schema.serverSubusers.createdAt,
    })
    .from(schema.serverSubusers)
    .innerJoin(schema.users, eq(schema.users.id, schema.serverSubusers.userId))
    .where(eq(schema.serverSubusers.serverId, id))
    .orderBy(asc(schema.users.username))
})
