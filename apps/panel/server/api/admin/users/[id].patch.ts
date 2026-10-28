import { count, eq } from 'drizzle-orm'
import { z } from 'zod'

const params = z.object({ id: z.uuid() })
const bodySchema = z.object({
  roleId: z.uuid().nullable().optional(),
  isAdmin: z.boolean().optional(),
})

export default defineEventHandler(async (event) => {
  const actor = await requireAdminPermission(event, 'admin.users.write')
  const { id } = await getValidatedRouterParams(event, params.parse)
  const body = await readValidatedBody(event, bodySchema.parse)
  const db = useDb()

  const target = await db.query.users.findFirst({ where: eq(schema.users.id, id), columns: { id: true, isAdmin: true } })
  if (!target) throw createError({ statusCode: 404, statusMessage: 'user not found' })

  // Superadmins can only be changed by superadmins.
  if ((target.isAdmin || body.isAdmin !== undefined) && !actor.isAdmin) {
    throw createError({ statusCode: 403, statusMessage: 'only superadmins can change superadmins' })
  }
  if (body.isAdmin === false && target.isAdmin) {
    const [row] = await db.select({ n: count() }).from(schema.users).where(eq(schema.users.isAdmin, true))
    if ((row?.n ?? 0) <= 1) throw createError({ statusCode: 409, statusMessage: 'cannot remove the last superadmin' })
  }
  if (body.roleId !== undefined) await assertRoleAssignable(actor, body.roleId)

  await db
    .update(schema.users)
    .set({
      ...(body.roleId !== undefined ? { roleId: body.roleId } : {}),
      ...(body.isAdmin !== undefined ? { isAdmin: body.isAdmin } : {}),
    })
    .where(eq(schema.users.id, id))
  return { ok: true }
})
