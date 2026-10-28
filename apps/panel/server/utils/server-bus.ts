/**
 * In-process pub/sub for per-server events (status changes, install results).
 * Browser websockets subscribe here; the tunnel publishes.
 */

export type ServerBusMessage =
  | { type: 'status'; status: string; message?: string | null }
  | { type: 'install'; success: boolean }
  | { type: 'backup'; backupId: string; restore: boolean; success: boolean }

type Listener = (msg: ServerBusMessage) => void

const listeners = new Map<string, Set<Listener>>()

export function subscribeServer(serverId: string, fn: Listener): () => void {
  let set = listeners.get(serverId)
  if (!set) {
    set = new Set()
    listeners.set(serverId, set)
  }
  set.add(fn)
  return () => {
    set!.delete(fn)
    if (set!.size === 0) listeners.delete(serverId)
  }
}

export function publishServer(serverId: string, msg: ServerBusMessage) {
  for (const fn of listeners.get(serverId) ?? []) {
    try {
      fn(msg)
    } catch (err) {
      console.error('[server-bus] listener failed:', err)
    }
  }
}
