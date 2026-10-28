import { count, eq } from 'drizzle-orm'
import { z } from 'zod'

const params = z.object({ id: z.uuid() })

/** Deletes a target that holds no backups. Servers using it fall back to the default. */
export default defineEventHandler(async (event) => {
  await requireAdminPermission(event, 'admin.backups.write')
  const { id } = await getValidatedRouterParams(event, params.parse)
  const db = useDb()
  const [{ n } = { n: 0 }] = await db.select({ n: count() }).from(schema.backups).where(eq(schema.backups.targetId, id))
  if (n > 0) throw createError({ statusCode: 409, statusMessage: `Ziel enthält noch ${n} Backup(s)` })
  const deleted = await db.delete(schema.backupTargets).where(eq(schema.backupTargets.id, id)).returning({ isDefault: schema.backupTargets.isDefault })
  if (!deleted.length) throw createError({ statusCode: 404, statusMessage: 'target not found' })
  // Keep a default around if there is any target left.
  if (deleted[0]!.isDefault) {
    const next = await db.query.backupTargets.findFirst({ columns: { id: true }, orderBy: (t, { asc }) => [asc(t.createdAt)] })
    if (next) await db.update(schema.backupTargets).set({ isDefault: true }).where(eq(schema.backupTargets.id, next.id))
  }
  setResponseStatus(event, 204)
  return null
})
