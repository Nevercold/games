import { eq } from 'drizzle-orm'
import { z } from 'zod'

const params = z.object({ id: z.uuid(), backupId: z.uuid() })

export default defineEventHandler(async (event) => {
  const { id, backupId } = await getValidatedRouterParams(event, params.parse)
  const { server } = await requireServerPermission(event, id, 'backup.delete')
  const { backup } = await loadBackup(id, backupId)
  if (backup.locked) throw createError({ statusCode: 409, statusMessage: 'Backup ist gesperrt' })
  if (backup.status === 'pending' || backup.restoring) throw createError({ statusCode: 409, statusMessage: 'Backup wird gerade verwendet' })
  if (backup.status === 'completed') {
    try {
      await deleteBackupArchive(backup, server)
    } catch (err) {
      throw toHttpError(err)
    }
  }
  await useDb().delete(schema.backups).where(eq(schema.backups.id, backupId))
  setResponseStatus(event, 204)
  return null
})
