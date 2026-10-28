import { and, asc, eq, inArray, or } from 'drizzle-orm'

/**
 * Servers the user owns or is a subuser of, with the user's own layout
 * (groups, order, colors).
 */
export default defineEventHandler(async (event) => {
  const actor = await requireActor(event)
  const db = useDb()

  const subServerIds = db
    .select({ id: schema.serverSubusers.serverId })
    .from(schema.serverSubusers)
    .where(eq(schema.serverSubusers.userId, actor.id))

  const rows = await db
    .select({
      id: schema.servers.id,
      name: schema.servers.name,
      description: schema.servers.description,
      status: schema.servers.status,
      ownerId: schema.servers.ownerId,
      nodeId: schema.servers.nodeId,
      nodeName: schema.nodes.name,
      publicHost: schema.nodes.publicHost,
      memoryMb: schema.servers.memoryMb,
      primaryAllocationId: schema.servers.primaryAllocationId,
      groupId: schema.userServerPrefs.groupId,
      sortOrder: schema.userServerPrefs.sortOrder,
      color: schema.userServerPrefs.color,
    })
    .from(schema.servers)
    .innerJoin(schema.nodes, eq(schema.nodes.id, schema.servers.nodeId))
    .leftJoin(
      schema.userServerPrefs,
      and(eq(schema.userServerPrefs.serverId, schema.servers.id), eq(schema.userServerPrefs.userId, actor.id)),
    )
    .where(or(eq(schema.servers.ownerId, actor.id), inArray(schema.servers.id, subServerIds)))

  const allocationIds = rows.map((r) => r.primaryAllocationId).filter((x): x is string => !!x)
  const allocs = allocationIds.length
    ? await db
        .select({ id: schema.allocations.id, port: schema.allocations.port })
        .from(schema.allocations)
        .where(inArray(schema.allocations.id, allocationIds))
    : []
  const portById = new Map(allocs.map((a) => [a.id, a.port]))

  const groups = await db
    .select({
      id: schema.serverGroups.id,
      name: schema.serverGroups.name,
      color: schema.serverGroups.color,
      sortOrder: schema.serverGroups.sortOrder,
      collapsed: schema.serverGroups.collapsed,
    })
    .from(schema.serverGroups)
    .where(eq(schema.serverGroups.userId, actor.id))
    .orderBy(asc(schema.serverGroups.sortOrder), asc(schema.serverGroups.createdAt))

  return {
    groups,
    servers: rows.map(({ primaryAllocationId, ...r }) => ({
      ...r,
      sortOrder: r.sortOrder ?? 0,
      isOwner: r.ownerId === actor.id,
      address: primaryAllocationId && portById.has(primaryAllocationId) ? `${r.publicHost}:${portById.get(primaryAllocationId)}` : null,
      nodeOnline: isNodeOnline(r.nodeId),
    })),
  }
})
