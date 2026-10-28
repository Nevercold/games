import { create, toBinary } from '@bufbuild/protobuf'
import {
  BackupCreateRequestSchema,
  BackupCreateResponseSchema,
  BackupDeleteRequestSchema,
  BackupDeleteResponseSchema,
  BackupDownloadOpenSchema,
  type BackupTarget,
  BackupTargetSchema,
} from '@panel/protocol'
import { randomUUID } from 'node:crypto'
import { and, asc, eq, inArray, lt } from 'drizzle-orm'
import { z } from 'zod'

// ---------------------------------------------------------------------------
// Target configuration (mirrors the daemon's internal/backup package)
// ---------------------------------------------------------------------------

const segment = /^[A-Za-z0-9._-]+$/
const keyPath = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/

export const targetConfigSchemas = {
  local: z.strictObject({
    subdir: z.string().trim().max(64).regex(segment).optional().or(z.literal('').transform(() => undefined)),
  }),
  s3: z.strictObject({
    endpoint: z.string().trim().min(1).max(255).regex(/^[A-Za-z0-9.-]+(:\d{1,5})?$/, 'host[:port] ohne Schema'),
    region: z.string().trim().max(64).optional(),
    bucket: z.string().trim().min(3).max(63).regex(/^[a-z0-9][a-z0-9.-]+[a-z0-9]$/, 'ungültiger Bucket-Name'),
    prefix: z.string().trim().max(200).regex(/^$|^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*\/?$/, 'ungültiger Präfix').optional(),
    accessKey: z.string().trim().min(1).max(256),
    secretKey: z.string().max(512).default(''),
    insecure: z.boolean().optional(),
    pathStyle: z.boolean().optional(),
  }),
  sftp: z.strictObject({
    host: z.string().trim().min(1).max(255),
    port: z.number().int().min(1).max(65535).optional(),
    username: z.string().trim().min(1).max(128),
    password: z.string().max(512).default(''),
    privateKey: z.string().max(16_384).default(''),
    path: z.string().trim().max(512).optional(),
    hostKey: z.string().trim().regex(/^$|^SHA256:[A-Za-z0-9+/]{43}$/, 'Fingerprint im Format SHA256:…').default(''),
  }),
} as const

export type TargetType = keyof typeof targetConfigSchemas
export const TARGET_TYPES = Object.keys(targetConfigSchemas) as TargetType[]

/** Fields that never leave the panel in API responses. */
export const SECRET_FIELDS: Record<TargetType, string[]> = { local: [], s3: ['secretKey'], sftp: ['password', 'privateKey'] }

export const targetInputSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('local'), config: targetConfigSchemas.local }),
  z.object({ type: z.literal('s3'), config: targetConfigSchemas.s3 }),
  z.object({ type: z.literal('sftp'), config: targetConfigSchemas.sftp }),
])
export type TargetInput = z.infer<typeof targetInputSchema>

const PURPOSE = 'backup-target'

export function encryptTargetConfig(config: Record<string, unknown>) {
  return encryptJson(config, PURPOSE)
}

export function decryptTargetConfig(row: { config: string }): Record<string, unknown> {
  return decryptJson<Record<string, unknown>>(row.config, PURPOSE)
}

/** Empty secret fields keep their previous value (forms never see secrets). */
export function mergeSecrets(type: TargetType, next: Record<string, unknown>, prev: Record<string, unknown> | null) {
  const out = { ...next }
  for (const f of SECRET_FIELDS[type]) {
    if (!out[f] && prev?.[f]) out[f] = prev[f]
  }
  return out
}

/** Config without secrets, plus which secrets are set. */
export function maskTargetConfig(type: TargetType, config: Record<string, unknown>) {
  const masked = { ...config }
  const secrets: Record<string, boolean> = {}
  for (const f of SECRET_FIELDS[type]) {
    secrets[f] = Boolean(masked[f])
    delete masked[f]
  }
  return { config: masked, secrets }
}

/** Checks that a (merged) config is usable; returns a message or null. */
export function incompleteReason(type: TargetType, config: Record<string, unknown>): string | null {
  if (type === 's3' && !config.secretKey) return 'Secret Key fehlt'
  if (type === 'sftp') {
    if (!config.password && !config.privateKey) return 'Passwort oder Private Key erforderlich'
    if (!config.hostKey) return 'Host-Key-Fingerprint fehlt (Verbindung testen, um ihn zu ermitteln)'
  }
  return null
}

export function targetProto(type: TargetType, config: Record<string, unknown>): BackupTarget {
  return create(BackupTargetSchema, { type, config: new TextEncoder().encode(JSON.stringify(config)) })
}

export function targetProtoFromRow(row: typeof schema.backupTargets.$inferSelect) {
  return targetProto(row.type, decryptTargetConfig(row))
}

// ---------------------------------------------------------------------------
// Backups
// ---------------------------------------------------------------------------

export function backupKey(serverId: string, backupId: string) {
  const key = `${serverId}/${backupId}.tar.zst`
  if (!keyPath.test(key)) throw new Error('invalid backup key')
  return key
}

/** The server's target, falling back to the default target. */
export async function resolveBackupTarget(server: { backupTargetId: string | null }) {
  const db = useDb()
  if (server.backupTargetId) {
    const t = await db.query.backupTargets.findFirst({ where: eq(schema.backupTargets.id, server.backupTargetId) })
    if (t) return t
  }
  return (await db.query.backupTargets.findFirst({ where: eq(schema.backupTargets.isDefault, true) })) ?? null
}

/**
 * Node that can reach a backup: local archives live on the node that wrote
 * them, remote targets are reachable from the server's current node.
 */
export function backupNodeId(
  backup: { nodeId: string | null },
  target: { type: TargetType },
  server: { nodeId: string },
): string | null {
  return target.type === 'local' ? backup.nodeId : server.nodeId
}

/** Removes the archive from storage (missing archives count as removed). */
export async function deleteBackupArchive(
  backup: typeof schema.backups.$inferSelect,
  server: { nodeId: string },
) {
  const target = await useDb().query.backupTargets.findFirst({ where: eq(schema.backupTargets.id, backup.targetId) })
  if (!target) return
  const nodeId = backupNodeId(backup, target, server)
  if (!nodeId) return // node is gone, and so is the archive
  await rpc(nodeId, 'backup.delete', BackupDeleteRequestSchema, { target: targetProtoFromRow(target), key: backup.key }, BackupDeleteResponseSchema, 60_000)
}

/**
 * Backups that must go before a new one fits under the limit: oldest
 * unlocked completed or failed ones. Returns null if locked backups alone
 * already fill the limit.
 */
export async function backupsToRotate(serverId: string, limit: number) {
  const rows = await useDb().query.backups.findMany({
    where: and(eq(schema.backups.serverId, serverId), inArray(schema.backups.status, ['completed', 'pending', 'failed'])),
    orderBy: [asc(schema.backups.createdAt)],
  })
  // Failed backups do not count against the limit but are cleaned up first.
  const failed = rows.filter((b) => b.status === 'failed')
  const counted = rows.filter((b) => b.status !== 'failed')
  const excess = counted.length - limit + 1
  if (excess <= 0) return failed
  const candidates = counted.filter((b) => b.status === 'completed' && !b.locked)
  if (candidates.length < excess) return null
  return [...failed, ...candidates.slice(0, excess)]
}

/**
 * Streams an archive from the node with credit-based flow control: the
 * daemon sends at most a window of chunks ahead and every chunk the
 * consumer pulls grants one more, so memory stays bounded.
 */
export function downloadBackupFromNode(nodeId: string, target: BackupTarget, key: string): ReadableStream<Uint8Array> {
  let handle: StreamHandle | undefined
  const credit = new Uint8Array([1])
  return new ReadableStream<Uint8Array>(
    {
      start(controller) {
        handle = openStream(nodeId, 'backup.download', toBinary(BackupDownloadOpenSchema, create(BackupDownloadOpenSchema, { target, key })), {
          onData(data) {
            if (data.length) controller.enqueue(data)
          },
          onClose(err) {
            if (err) controller.error(err)
            else controller.close()
          },
        })
      },
      pull() {
        handle?.send(credit)
      },
      cancel() {
        handle?.close()
      },
    },
    { highWaterMark: 4 },
  )
}

/** Loads a backup of a server together with its target (404 otherwise). */
export async function loadBackup(serverId: string, backupId: string) {
  const backup = await useDb().query.backups.findFirst({
    where: and(eq(schema.backups.id, backupId), eq(schema.backups.serverId, serverId)),
  })
  if (!backup) throw createError({ statusCode: 404, statusMessage: 'backup not found' })
  const target = await useDb().query.backupTargets.findFirst({ where: eq(schema.backupTargets.id, backup.targetId) })
  if (!target) throw createError({ statusCode: 404, statusMessage: 'backup target not found' })
  return { backup, target }
}

/** A daemon restart loses running jobs; give up on them after a while. */
const STALE_AFTER_MS = 12 * 60 * 60 * 1000

export async function expireStaleBackups(serverId: string) {
  const cutoff = new Date(Date.now() - STALE_AFTER_MS)
  const db = useDb()
  await db
    .update(schema.backups)
    .set({ status: 'failed', error: 'Zeitüberschreitung (Daemon neu gestartet?)', completedAt: new Date() })
    .where(and(eq(schema.backups.serverId, serverId), eq(schema.backups.status, 'pending'), lt(schema.backups.createdAt, cutoff)))
  await db
    .update(schema.backups)
    .set({ restoring: false })
    .where(and(eq(schema.backups.serverId, serverId), eq(schema.backups.restoring, true), lt(schema.backups.updatedAt, cutoff)))
}

/** Creates a backup (API and schedules). Rotates old backups first. */
export async function createServerBackup(
  server: typeof schema.servers.$inferSelect,
  opts: { name?: string; ignore?: string; createdById?: string | null },
) {
  if (server.backupLimit <= 0) throw createError({ statusCode: 409, statusMessage: 'Backups sind für diesen Server deaktiviert' })
  const target = await resolveBackupTarget(server)
  if (!target) throw createError({ statusCode: 409, statusMessage: 'Kein Backup-Ziel konfiguriert' })
  if (!isNodeOnline(server.nodeId)) throw createError({ statusCode: 503, statusMessage: 'Node ist offline' })
  await expireStaleBackups(server.id)

  const rotate = await backupsToRotate(server.id, server.backupLimit)
  if (!rotate) throw createError({ statusCode: 409, statusMessage: 'Backup-Limit erreicht und alle Backups sind gesperrt' })
  const db = useDb()
  for (const old of rotate) {
    try {
      await deleteBackupArchive(old, server)
    } catch (err) {
      throw createError({ statusCode: 502, statusMessage: `Altes Backup „${old.name}“ konnte nicht entfernt werden: ${(toHttpError(err) as Error).message}` })
    }
    await db.delete(schema.backups).where(eq(schema.backups.id, old.id))
  }

  const backupId = randomUUID()
  const ignore = (opts.ignore ?? '').split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 200)
  const name = opts.name || `Backup ${new Date().toLocaleString('de-DE', { timeZone: 'Europe/Berlin' })}`
  let row
  try {
    ;[row] = await db
      .insert(schema.backups)
      .values({ id: backupId, serverId: server.id, targetId: target.id, nodeId: server.nodeId, name, key: backupKey(server.id, backupId), ignore, createdById: opts.createdById ?? null })
      .returning()
  } catch (err) {
    if (isUniqueViolation(err)) throw createError({ statusCode: 409, statusMessage: 'Es läuft bereits ein Backup' })
    throw err
  }
  try {
    await rpc(server.nodeId, 'backup.create', BackupCreateRequestSchema, {
      serverId: server.id,
      backupId,
      target: targetProtoFromRow(target),
      key: row!.key,
      ignore,
    }, BackupCreateResponseSchema, 30_000)
  } catch (err) {
    const e = toHttpError(err) as Error
    await db.update(schema.backups).set({ status: 'failed', error: e.message, completedAt: new Date() }).where(eq(schema.backups.id, backupId))
    throw e
  }
  return { id: backupId }
}
