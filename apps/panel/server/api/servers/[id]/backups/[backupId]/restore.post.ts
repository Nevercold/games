import { BackupRestoreRequestSchema, BackupRestoreResponseSchema } from '@panel/protocol'
import { and, eq } from 'drizzle-orm'
import { z } from 'zod'

const params = z.object({ id: z.uuid(), backupId: z.uuid() })
const body = z.object({ truncate: z.boolean().default(false) })

export default defineEventHandler(async (event) => {
  const { id, backupId } = await getValidatedRouterParams(event, params.parse)
  const { truncate } = await readValidatedBody(event, body.parse)
  const { server } = await requireServerPermission(event, id, 'backup.restore')
  const { backup, target } = await loadBackup(id, backupId)
  if (backup.status !== 'completed') throw createError({ statusCode: 409, statusMessage: 'Backup ist nicht abgeschlossen' })
  if (server.status !== 'offline' && server.status !== 'install_failed') {
    throw createError({ statusCode: 409, statusMessage: 'Server muss zum Wiederherstellen gestoppt sein' })
  }
  if (target.type === 'local' && backup.nodeId !== server.nodeId) {
    throw createError({ statusCode: 409, statusMessage: 'Lokales Backup liegt auf einer anderen Node' })
  }
  if (!isNodeOnline(server.nodeId)) throw createError({ statusCode: 503, statusMessage: 'Node ist offline' })

  const db = useDb()
  // Flip the flag atomically so two restores cannot race.
  const claimed = await db
    .update(schema.backups)
    .set({ restoring: true })
    .where(and(eq(schema.backups.id, backupId), eq(schema.backups.restoring, false)))
    .returning({ id: schema.backups.id })
  if (!claimed.length) throw createError({ statusCode: 409, statusMessage: 'Wiederherstellung läuft bereits' })

  try {
    await rpc(server.nodeId, 'backup.restore', BackupRestoreRequestSchema, {
      serverId: id,
      backupId,
      target: targetProtoFromRow(target),
      key: backup.key,
      truncate,
      diskLimitBytes: BigInt(diskLimitBytes(server)),
      sha256: backup.sha256 ?? '',
    }, BackupRestoreResponseSchema, 30_000)
  } catch (err) {
    await db.update(schema.backups).set({ restoring: false }).where(eq(schema.backups.id, backupId))
    throw toHttpError(err)
  }
  return { ok: true }
})
