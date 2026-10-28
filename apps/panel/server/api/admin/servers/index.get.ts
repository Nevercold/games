import { desc } from 'drizzle-orm'

export default defineEventHandler(async (event) => {
  await requireAdminPermission(event, 'admin.servers.read')
  return useDb().query.servers.findMany({
    orderBy: [desc(schema.servers.createdAt)],
    columns: { variables: false },
    with: {
      owner: { columns: { id: true, username: true } },
      node: { columns: { id: true, name: true, publicHost: true } },
      allocations: { columns: { id: true, ip: true, port: true } },
    },
  })
})
