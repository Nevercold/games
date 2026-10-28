import { eq } from 'drizzle-orm'
import { z } from 'zod'

const params = z.object({ id: z.uuid(), backupId: z.uuid() })
const body = z.object({ locked: z.boolean() })

export default defineEventHandler(async (event) => {
  const { id, backupId } = await getValidatedRouterParams(event, params.parse)
  const { locked } = await readValidatedBody(event, body.parse)
  await requireServerPermission(event, id, 'backup.delete')
  await loadBackup(id, backupId)
  await useDb().update(schema.backups).set({ locked }).where(eq(schema.backups.id, backupId))
  return { ok: true }
})
