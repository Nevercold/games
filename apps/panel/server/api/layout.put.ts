import { and, eq, inArray, or, sql } from 'drizzle-orm'
import { z } from 'zod'

/**
 * Saves the user's dashboard layout after drag & drop: group order and,
 * per server, its group and position. Only the user's own groups and
 * servers they can access are accepted.
 */
const bodySchema = z.object({
  groups: z.array(z.uuid()).max(100),
  servers: z
    .array(z.object({ serverId: z.uuid(), groupId: z.uuid().nullable() }))
    .max(2000),
})

export default defineEventHandler(async (event) => {
  const actor = await requireActor(event)
  const body = await readValidatedBody(event, bodySchema.parse)
  const db = useDb()

  const ownGroups = new Set(
    (
      await db.select({ id: schema.serverGroups.id }).from(schema.serverGroups).where(eq(schema.serverGroups.userId, actor.id))
    ).map((g) => g.id),
  )
  if (body.groups.some((g) => !ownGroups.has(g)) || body.servers.some((s) => s.groupId && !ownGroups.has(s.groupId))) {
    throw createError({ statusCode: 422, statusMessage: 'unknown group' })
  }

  const serverIds = body.servers.map((s) => s.serverId)
  const accessible = new Set(
    serverIds.length
      ? (
          await db
            .select({ id: schema.servers.id })
            .from(schema.servers)
            .where(
              and(
                inArray(schema.servers.id, serverIds),
                or(
                  eq(schema.servers.ownerId, actor.id),
                  inArray(
                    schema.servers.id,
                    db.select({ id: schema.serverSubusers.serverId }).from(schema.serverSubusers).where(eq(schema.serverSubusers.userId, actor.id)),
                  ),
                ),
              ),
            )
        ).map((s) => s.id)
      : [],
  )
  if (serverIds.some((id) => !accessible.has(id))) throw createError({ statusCode: 422, statusMessage: 'unknown server' })

  await db.transaction(async (tx) => {
    for (const [i, groupId] of body.groups.entries()) {
      await tx.update(schema.serverGroups).set({ sortOrder: i }).where(eq(schema.serverGroups.id, groupId))
    }
    // Position counts per group, so ordering is stable inside each section.
    const position = new Map<string, number>()
    for (const s of body.servers) {
      const key = s.groupId ?? ''
      const sortOrder = position.get(key) ?? 0
      position.set(key, sortOrder + 1)
      await tx
        .insert(schema.userServerPrefs)
        .values({ userId: actor.id, serverId: s.serverId, groupId: s.groupId, sortOrder })
        .onConflictDoUpdate({
          target: [schema.userServerPrefs.userId, schema.userServerPrefs.serverId],
          set: { groupId: s.groupId, sortOrder: sql`excluded.sort_order` },
        })
    }
  })
  return { ok: true }
})
