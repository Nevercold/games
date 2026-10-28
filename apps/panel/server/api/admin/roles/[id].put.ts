import { eq } from 'drizzle-orm'
import { z } from 'zod'

const params = z.object({ id: z.uuid() })

export default defineEventHandler(async (event) => {
  const actor = await requireAdminPermission(event, 'admin.roles.write')
  const { id } = await getValidatedRouterParams(event, params.parse)
  const body = await readValidatedBody(event, roleBodySchema.parse)
  const db = useDb()

  const role = await db.query.roles.findFirst({ where: eq(schema.roles.id, id) })
  if (!role) throw createError({ statusCode: 404, statusMessage: 'role not found' })
  // Both the old and the new permission set must be within the actor's rights,
  // otherwise one could strip or add rights beyond their own level.
  assertPermissionsHeld(actor, [...role.permissions, ...body.permissions])

  try {
    await db.update(schema.roles).set(body).where(eq(schema.roles.id, id))
  } catch (err) {
    if (isUniqueViolation(err)) throw createError({ statusCode: 409, statusMessage: 'role name already exists' })
    throw err
  }
  return { ok: true }
})
