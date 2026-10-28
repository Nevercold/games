import { ServerState, ServerStatesRequestSchema, ServerStatesResponseSchema, type Event } from '@panel/protocol'
import { and, eq, inArray, ne } from 'drizzle-orm'

type DbStatus = (typeof schema.serverStatus.enumValues)[number]

export function stateToStatus(state: ServerState): DbStatus | null {
  switch (state) {
    case ServerState.OFFLINE:
      return 'offline'
    case ServerState.STARTING:
      return 'starting'
    case ServerState.RUNNING:
      return 'running'
    case ServerState.STOPPING:
      return 'stopping'
    case ServerState.INSTALLING:
      return 'installing'
    default:
      return null
  }
}

/**
 * Updates the status of a server that belongs to `nodeId`. The node check
 * stops a compromised daemon from changing servers of other nodes.
 */
async function setStatus(
  nodeId: string,
  serverId: string,
  status: DbStatus,
  message?: string | null,
  opts: { unlessInstalling?: boolean } = {},
) {
  const updated = await useDb()
    .update(schema.servers)
    .set({ status, ...(message !== undefined ? { statusMessage: message } : {}) })
    .where(
      and(
        eq(schema.servers.id, serverId),
        eq(schema.servers.nodeId, nodeId),
        opts.unlessInstalling ? ne(schema.servers.status, 'installing') : undefined,
      ),
    )
    .returning({ id: schema.servers.id })
  if (updated.length) publishServer(serverId, { type: 'status', status, message })
}

/** Handles an event pushed by a daemon. */
export async function handleDaemonEvent(nodeId: string, event: Event) {
  switch (event.kind.case) {
    case 'stateChanged': {
      const { serverId, state, crashed } = event.kind.value
      const status = stateToStatus(state)
      if (!status) return
      // Installing is driven by InstallFinished; ignore the daemon's
      // intermediate "offline" so the UI does not flicker.
      await setStatus(
        nodeId,
        serverId,
        status,
        crashed ? 'Server wurde unerwartet beendet' : status === 'starting' ? null : undefined,
        { unlessInstalling: status === 'offline' },
      )
      break
    }
    case 'installFinished': {
      const { serverId, success, logTail } = event.kind.value
      const message = success ? null : `Installation fehlgeschlagen:\n${logTail.slice(-2000)}`
      await setStatus(nodeId, serverId, success ? 'offline' : 'install_failed', message)
      publishServer(serverId, { type: 'install', success })
      break
    }
  }
}

/**
 * After (re)connecting, align DB status with what the daemon actually runs.
 * A server stuck in "installing" whose daemon reports offline lost its
 * install (daemon restart) and is marked failed.
 */
export async function syncNodeStates(nodeId: string) {
  const db = useDb()
  const servers = await db
    .select({ id: schema.servers.id, status: schema.servers.status })
    .from(schema.servers)
    .where(eq(schema.servers.nodeId, nodeId))
  if (!servers.length) return

  const res = await rpc(nodeId, 'states', ServerStatesRequestSchema, { serverIds: servers.map((s) => s.id) }, ServerStatesResponseSchema)
  for (const s of servers) {
    if (s.status === 'suspended') continue
    const reported = stateToStatus(res.states[s.id] ?? ServerState.OFFLINE) ?? 'offline'
    if (s.status === 'installing' && reported === 'offline') {
      await setStatus(nodeId, s.id, 'install_failed', 'Installation wurde unterbrochen (Daemon-Neustart)')
    } else if (s.status === 'install_failed' && reported === 'offline') {
      publishServer(s.id, { type: 'status', status: s.status })
    } else if (reported !== s.status) {
      await setStatus(nodeId, s.id, reported)
    } else {
      // Unchanged, but open browser consoles need the signal to re-attach.
      publishServer(s.id, { type: 'status', status: s.status })
    }
  }
}

/** Marks running servers of a disconnected node as unknown→offline in the UI. */
export async function markNodeServersUnknown(nodeId: string) {
  const db = useDb()
  const rows = await db
    .select({ id: schema.servers.id })
    .from(schema.servers)
    .where(and(eq(schema.servers.nodeId, nodeId), inArray(schema.servers.status, ['starting', 'running', 'stopping'])))
  for (const r of rows) publishServer(r.id, { type: 'status', status: 'unknown' })
}
