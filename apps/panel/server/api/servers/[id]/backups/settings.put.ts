import { eq } from 'drizzle-orm'
import { z } from 'zod'

const params = z.object({ id: z.uuid() })
const body = z.object({
  backupLimit: z.number().int().min(0).max(1000),
  backupTargetId: z.uuid().nullable(),
})

/** Backup limit and target of a server (admins only). */
export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, params.parse)
  const input = await readValidatedBody(event, body.parse)
  const { actor } = await requireServerPermission(event, id, 'backup.read')
  if (!actor.adminPermissions.has('admin.servers.write')) throw createError({ statusCode: 403, statusMessage: 'missing permission admin.servers.write' })
  if (input.backupTargetId) {
    const t = await useDb().query.backupTargets.findFirst({ where: eq(schema.backupTargets.id, input.backupTargetId), columns: { id: true } })
    if (!t) throw createError({ statusCode: 422, statusMessage: 'Backup-Ziel nicht gefunden' })
  }
  await useDb().update(schema.servers).set(input).where(eq(schema.servers.id, id))
  return { ok: true }
})
