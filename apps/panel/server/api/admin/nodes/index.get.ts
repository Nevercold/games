import { asc, count, eq } from 'drizzle-orm'

export default defineEventHandler(async (event) => {
  await requireAdminPermission(event, 'admin.nodes.read')
  const db = useDb()

  const rows = await db
    .select({
      id: schema.nodes.id,
      name: schema.nodes.name,
      description: schema.nodes.description,
      publicHost: schema.nodes.publicHost,
      memoryMb: schema.nodes.memoryMb,
      diskMb: schema.nodes.diskMb,
      lastSeenAt: schema.nodes.lastSeenAt,
      daemonVersion: schema.nodes.daemonVersion,
      createdAt: schema.nodes.createdAt,
      serverCount: count(schema.servers.id),
    })
    .from(schema.nodes)
    .leftJoin(schema.servers, eq(schema.servers.nodeId, schema.nodes.id))
    .groupBy(schema.nodes.id)
    .orderBy(asc(schema.nodes.name))

  return rows.map((n) => ({ ...n, online: isNodeOnline(n.id) }))
})
