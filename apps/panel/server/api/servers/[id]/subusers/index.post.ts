import { sql } from 'drizzle-orm'
import { z } from 'zod'

const params = z.object({ id: z.uuid() })
const bodySchema = z.object({
  /** Email or username of an existing account. */
  login: z.string().trim().min(1).max(255),
  permissions: subuserPermissionsSchema,
})

export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, params.parse)
  const body = await readValidatedBody(event, bodySchema.parse)
  const { server, permissions, actor } = await requireServerPermission(event, id, 'user.write')
  assertGrantable(permissions, body.permissions)

  const db = useDb()
  const login = body.login.toLowerCase()
  const user = await db.query.users.findFirst({
    where: sql`lower(${schema.users.email}) = ${login} or lower(${schema.users.username}) = ${login}`,
    columns: { id: true },
  })
  // Same message for "unknown" and "not allowed" to avoid user enumeration.
  if (!user || user.id === server.ownerId || user.id === actor.id) {
    throw createError({ statusCode: 422, statusMessage: 'user cannot be added' })
  }

  const inserted = await db
    .insert(schema.serverSubusers)
    .values({ serverId: id, userId: user.id, permissions: body.permissions })
    .onConflictDoNothing()
    .returning({ id: schema.serverSubusers.id })
  if (!inserted.length) throw createError({ statusCode: 409, statusMessage: 'user is already a subuser' })

  setResponseStatus(event, 201)
  return inserted[0]
})
