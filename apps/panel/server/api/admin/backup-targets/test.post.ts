import { BackupTestRequestSchema, BackupTestResponseSchema } from '@panel/protocol'
import { eq } from 'drizzle-orm'
import { z } from 'zod'

const body = z.intersection(z.object({ nodeId: z.uuid(), id: z.uuid().optional() }), targetInputSchema)

/**
 * Tests a (possibly unsaved) target from a node: write, read back, delete.
 * For SFTP without a pinned host key it only reports the fingerprint.
 */
export default defineEventHandler(async (event) => {
  await requireAdminPermission(event, 'admin.backups.write')
  const input = await readValidatedBody(event, body.parse)
  let previous: Record<string, unknown> | null = null
  if (input.id) {
    const existing = await useDb().query.backupTargets.findFirst({ where: eq(schema.backupTargets.id, input.id) })
    if (existing?.type === input.type) {
      try {
        previous = decryptTargetConfig(existing)
      } catch {}
    }
  }
  const config = mergeSecrets(input.type, input.config, previous)
  if (!isNodeOnline(input.nodeId)) throw createError({ statusCode: 503, statusMessage: 'Node ist offline' })
  try {
    const res = await rpc(input.nodeId, 'backup.test', BackupTestRequestSchema, { target: targetProto(input.type, config) }, BackupTestResponseSchema, 70_000)
    const fp = res.hostKeyFingerprint
    if (input.type === 'sftp' && !config.hostKey) {
      return { ok: false, hostKeyFingerprint: fp, message: 'Host-Key noch nicht bestätigt' }
    }
    return { ok: true, hostKeyFingerprint: fp || null }
  } catch (err) {
    const e = toHttpError(err) as { statusCode?: number; statusMessage?: string }
    return { ok: false, hostKeyFingerprint: null, message: e.statusMessage ?? String(err) }
  }
})
