import { count } from 'drizzle-orm'

/** Backup targets with masked credentials, plus nodes for connection tests. */
export default defineEventHandler(async (event) => {
  await requireAdminPermission(event, 'admin.backups.write')
  const db = useDb()
  const [targets, usage, nodes] = await Promise.all([
    db.query.backupTargets.findMany({ orderBy: (t, { asc }) => [asc(t.name)] }),
    db.select({ targetId: schema.backups.targetId, n: count() }).from(schema.backups).groupBy(schema.backups.targetId),
    db.query.nodes.findMany({ columns: { id: true, name: true }, orderBy: (n, { asc }) => [asc(n.name)] }),
  ])
  const counts = new Map(usage.map((u) => [u.targetId, u.n]))
  return {
    targets: targets.map((t) => {
      let masked: ReturnType<typeof maskTargetConfig> = { config: {}, secrets: {} }
      let error: string | null = null
      try {
        masked = maskTargetConfig(t.type, decryptTargetConfig(t))
      } catch {
        error = 'Zugangsdaten nicht lesbar (NUXT_APP_KEY geändert?)'
      }
      return { id: t.id, name: t.name, type: t.type, isDefault: t.isDefault, ...masked, error, backups: counts.get(t.id) ?? 0 }
    }),
    nodes: nodes.map((n) => ({ ...n, online: isNodeOnline(n.id) })),
  }
})

