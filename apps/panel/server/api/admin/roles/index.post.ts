export default defineEventHandler(async (event) => {
  const actor = await requireAdminPermission(event, 'admin.roles.write')
  const body = await readValidatedBody(event, roleBodySchema.parse)
  assertPermissionsHeld(actor, body.permissions)
  try {
    const [role] = await useDb().insert(schema.roles).values(body).returning()
    setResponseStatus(event, 201)
    return role
  } catch (err) {
    if (isUniqueViolation(err)) throw createError({ statusCode: 409, statusMessage: 'role name already exists' })
    throw err
  }
})
