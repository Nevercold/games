import { eq } from 'drizzle-orm'
import { z } from 'zod'

const params = z.object({ id: z.uuid() })

/** Users of the role lose it (FK set null) and keep only their server rights. */
export default defineEventHandler(async (event) => {
  const actor = await requireAdminPermission(event, 'admin.roles.write')
  const { id } = await getValidatedRouterParams(event, params.parse)
  const db = useDb()
  const role = await db.query.roles.findFirst({ where: eq(schema.roles.id, id) })
  if (!role) throw createError({ statusCode: 404, statusMessage: 'role not found' })
  assertPermissionsHeld(actor, role.permissions)
  await db.delete(schema.roles).where(eq(schema.roles.id, id))
  setResponseStatus(event, 204)
  return null
})
