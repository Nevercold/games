import { asc, eq } from 'drizzle-orm'

export default defineEventHandler(async (event) => {
  await requireAdminPermission(event, 'admin.users.read')
  return useDb()
    .select({
      id: schema.users.id,
      email: schema.users.email,
      username: schema.users.username,
      isAdmin: schema.users.isAdmin,
      roleId: schema.users.roleId,
      roleName: schema.roles.name,
      createdAt: schema.users.createdAt,
    })
    .from(schema.users)
    .leftJoin(schema.roles, eq(schema.roles.id, schema.users.roleId))
    .orderBy(asc(schema.users.username))
})
