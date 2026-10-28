import { Readable } from 'node:stream'
import { z } from 'zod'

const params = z.object({ id: z.uuid(), backupId: z.uuid() })

export default defineEventHandler(async (event) => {
  const { id, backupId } = await getValidatedRouterParams(event, params.parse)
  const { server } = await requireServerPermission(event, id, 'backup.download')
  const { backup, target } = await loadBackup(id, backupId)
  if (backup.status !== 'completed') throw createError({ statusCode: 409, statusMessage: 'Backup ist nicht abgeschlossen' })
  const nodeId = backupNodeId(backup, target, server)
  if (!nodeId || !isNodeOnline(nodeId)) throw createError({ statusCode: 503, statusMessage: 'Node mit dem Backup ist offline' })

  const stamp = (backup.completedAt ?? backup.createdAt).toISOString().slice(0, 19).replace(/[:T]/g, '-')
  const safeName = server.name.replace(/[^\w.-]+/g, '_').slice(0, 60) || 'server'
  setResponseHeaders(event, {
    'content-type': 'application/zstd',
    'content-disposition': attachmentHeader(`${safeName}-${stamp}.tar.zst`),
    'content-length': backup.sizeBytes,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  // Node stream piping honours the client's pace; with the credit window
  // in downloadBackupFromNode memory stays bounded for any archive size.
  const body = Readable.fromWeb(downloadBackupFromNode(nodeId, targetProtoFromRow(target), backup.key) as never)
  event.node.res.once('close', () => body.destroy())
  return sendStream(event, body)
})
