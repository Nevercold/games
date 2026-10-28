import { create, fromBinary, toBinary } from '@bufbuild/protobuf'
import { ConsoleOpenSchema, StatsOpenSchema, StatsSampleSchema } from '@panel/protocol'
import type { Peer } from 'crossws'

/**
 * Browser ↔ panel websocket for one server: console output, commands,
 * live stats and status changes. The panel bridges to the daemon through
 * the node tunnel, so browsers never talk to nodes directly.
 *
 * Client → server: {"type":"command","line":"..."}
 * Server → client: {"type":"output","data":"..."} | {"type":"stats",...}
 *                  {"type":"status","status":"..."} | {"type":"error","message":"..."}
 */

interface Session {
  serverId: string
  nodeId: string
  canCommand: boolean
  console?: StreamHandle
  stats?: StreamHandle
  unsubscribe?: () => void
  decoder: TextDecoder
}

const sessions = new WeakMap<Peer, Session>()
const MAX_COMMAND_LENGTH = 4096

function sendJson(peer: Peer, msg: unknown) {
  peer.send(JSON.stringify(msg))
}

function serverIdFromUrl(url: string): string | null {
  const m = /\/api\/servers\/([0-9a-f-]{36})\/ws(?:\?|$)/i.exec(new URL(url).pathname + '?')
  return m ? m[1]! : null
}

/** Opens daemon streams; called on connect and again when the node comes back. */
function attachStreams(peer: Peer, s: Session) {
  if (!isNodeOnline(s.nodeId)) {
    sendJson(peer, { type: 'error', message: 'Node ist offline' })
    return
  }
  try {
    s.console = openStream(s.nodeId, 'console', toBinary(ConsoleOpenSchema, create(ConsoleOpenSchema, { serverId: s.serverId })), {
      onData: (data) => sendJson(peer, { type: 'output', data: s.decoder.decode(data, { stream: true }) }),
      onClose: (err) => {
        s.console = undefined
        if (err) sendJson(peer, { type: 'error', message: err.message })
      },
    })
    s.stats = openStream(s.nodeId, 'stats', toBinary(StatsOpenSchema, create(StatsOpenSchema, { serverId: s.serverId })), {
      onData: (data) => {
        const st = fromBinary(StatsSampleSchema, data)
        sendJson(peer, {
          type: 'stats',
          cpu: st.cpuPercent,
          memory: Number(st.memoryBytes),
          memoryLimit: Number(st.memoryLimitBytes),
          netRx: Number(st.netRxBytes),
          netTx: Number(st.netTxBytes),
          disk: Number(st.diskBytes),
          uptimeMs: Number(st.uptimeMs),
        })
      },
      onClose: () => {
        s.stats = undefined
      },
    })
  } catch (err) {
    sendJson(peer, { type: 'error', message: err instanceof Error ? err.message : 'stream failed' })
  }
}

export default defineWebSocketHandler({
  async upgrade(request) {
    // Browsers send cookies cross-site on websocket upgrades: enforce same
    // origin to prevent cross-site websocket hijacking.
    const origin = request.headers.get('origin')
    const host = request.headers.get('host')
    if (!origin || !host || new URL(origin).host !== host) {
      throw new Response('origin not allowed', { status: 403 })
    }
    const serverId = serverIdFromUrl(request.url)
    if (!serverId) throw new Response('not found', { status: 404 })

    let actor: Actor
    try {
      actor = await requireActor(request as unknown as Request)
    } catch {
      throw new Response('unauthorized', { status: 401 })
    }
    const access = await getServerAccess(actor, serverId)
    if (!access?.permissions.has('control.console')) throw new Response('not found', { status: 404 })

    request.context.serverId = serverId
    request.context.nodeId = access.server.nodeId
    request.context.canCommand = access.permissions.has('control.command')
    request.context.status = access.server.status
  },

  open(peer) {
    const s: Session = {
      serverId: peer.context.serverId as string,
      nodeId: peer.context.nodeId as string,
      canCommand: peer.context.canCommand === true,
      decoder: new TextDecoder(),
    }
    sessions.set(peer, s)
    sendJson(peer, { type: 'status', status: peer.context.status })
    s.unsubscribe = subscribeServer(s.serverId, (msg) => {
      sendJson(peer, msg)
      // Re-open streams once the node is back after an outage.
      if (msg.type === 'status' && msg.status !== 'unknown' && !s.console) attachStreams(peer, s)
    })
    attachStreams(peer, s)
  },

  message(peer, message) {
    const s = sessions.get(peer)
    if (!s) return
    let msg: { type?: string; line?: unknown }
    try {
      msg = JSON.parse(message.text())
    } catch {
      return
    }
    if (msg.type === 'command' && typeof msg.line === 'string') {
      if (!s.canCommand) return sendJson(peer, { type: 'error', message: 'Keine Berechtigung für Befehle' })
      const line = msg.line.slice(0, MAX_COMMAND_LENGTH)
      if (!s.console) return sendJson(peer, { type: 'error', message: 'Konsole nicht verbunden' })
      s.console.send(new TextEncoder().encode(line))
    }
  },

  close(peer) {
    const s = sessions.get(peer)
    if (!s) return
    s.unsubscribe?.()
    s.console?.close()
    s.stats?.close()
    sessions.delete(peer)
  },
})
