import { z } from 'zod'

const bodySchema = z.object({
  email: z.email().max(255),
  username: z.string().trim().min(3).max(32).regex(/^[a-zA-Z0-9_.-]+$/),
  password: z.string().min(10).max(1024),
  isAdmin: z.boolean().default(false),
  roleId: z.uuid().nullable().default(null),
})

export default defineEventHandler(async (event) => {
  const actor = await requireAdminPermission(event, 'admin.users.write')
  const { password, ...body } = await readValidatedBody(event, bodySchema.parse)
  // Only superadmins create superadmins; otherwise anyone with users.write
  // could escalate to full control.
  if (body.isAdmin && !actor.isAdmin) {
    throw createError({ statusCode: 403, statusMessage: 'only superadmins can create superadmins' })
  }
  await assertRoleAssignable(actor, body.roleId)
  const passwordHash = await hashPassword(password)

  try {
    const [user] = await useDb()
      .insert(schema.users)
      .values({ ...body, passwordHash })
      .returning({ id: schema.users.id, username: schema.users.username })
    await usePanelHooks().callHook('user.created', { userId: user!.id })
    setResponseStatus(event, 201)
    return user
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw createError({ statusCode: 409, statusMessage: 'email or username already taken' })
    }
    throw err
  }
})
