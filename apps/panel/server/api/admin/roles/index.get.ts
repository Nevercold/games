import { asc, count, eq } from 'drizzle-orm'

export default defineEventHandler(async (event) => {
  await requireAdminPermission(event, 'admin.users.read')
  return useDb()
    .select({
      id: schema.roles.id,
      name: schema.roles.name,
      description: schema.roles.description,
      permissions: schema.roles.permissions,
      userCount: count(schema.users.id),
    })
    .from(schema.roles)
    .leftJoin(schema.users, eq(schema.users.roleId, schema.roles.id))
    .groupBy(schema.roles.id)
    .orderBy(asc(schema.roles.name))
})
