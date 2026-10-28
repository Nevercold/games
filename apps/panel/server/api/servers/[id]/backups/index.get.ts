import { desc, eq } from 'drizzle-orm'
import { z } from 'zod'

const params = z.object({ id: z.uuid() })

export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, params.parse)
  const { server, actor } = await requireServerPermission(event, id, 'backup.read')
  await expireStaleBackups(id)
  const db = useDb()
  const [rows, target] = await Promise.all([
    db.query.backups.findMany({ where: eq(schema.backups.serverId, id), orderBy: [desc(schema.backups.createdAt)] }),
    resolveBackupTarget(server),
  ])
  const canConfigure = actor.adminPermissions.has('admin.servers.write')
  const targets = canConfigure
    ? (await db.query.backupTargets.findMany({ columns: { id: true, name: true, type: true, isDefault: true }, orderBy: (t, { asc }) => [asc(t.name)] }))
    : []
  return {
    backups: rows.map((b) => ({
      id: b.id,
      name: b.name,
      status: b.status,
      sizeBytes: b.sizeBytes,
      sha256: b.sha256,
      locked: b.locked,
      restoring: b.restoring,
      error: b.error,
      createdAt: b.createdAt,
      completedAt: b.completedAt,
    })),
    limit: server.backupLimit,
    target: target ? { id: target.id, name: target.name, type: target.type } : null,
    serverTargetId: server.backupTargetId,
    serverStatus: server.status,
    canConfigure,
    targets,
  }
})
