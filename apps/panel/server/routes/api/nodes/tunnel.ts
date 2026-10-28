import { create, fromBinary } from '@bufbuild/protobuf'
import { EnvelopeSchema, HelloAckSchema, PongSchema, TunnelErrorSchema } from '@panel/protocol'
import { PROTOCOL_VERSION } from '@panel/shared'
import { eq } from 'drizzle-orm'

/**
 * Daemon tunnel endpoint: wss://<panel>/api/nodes/tunnel
 * Auth: `Authorization: Bearer <nodeId>.<secret>` on the upgrade request.
 * Every binary frame is one protobuf Envelope.
 */

const PANEL_VERSION = '0.0.0'

function reject(status: number, message: string): never {
  throw new Response(message, { status })
}

export default defineWebSocketHandler({
  async upgrade(request) {
    const auth = request.headers.get('authorization') ?? ''
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
    const parsed = parseNodeToken(token)
    if (!parsed) reject(401, 'missing or malformed node token')

    const db = useDb()
    const node = await db.query.nodes.findFirst({
      where: eq(schema.nodes.id, parsed.nodeId),
      columns: { id: true, tokenHash: true },
    }).catch(() => undefined) // invalid uuid → treat as unknown node
    if (!node || !verifyNodeSecret(parsed.secret, node.tokenHash)) {
      reject(401, 'invalid node token')
    }

    request.context.nodeId = node.id
  },

  open(peer) {
    const nodeId = peer.context.nodeId as string
    registerTunnel(nodeId, peer)
    console.info(`[tunnel] node ${nodeId} connected from ${peer.remoteAddress ?? 'unknown'}`)
  },

  async message(peer, message) {
    const nodeId = peer.context.nodeId as string
    const conn = getTunnel(nodeId)
    if (!conn || conn.peer.id !== peer.id) return

    let envelope
    try {
      envelope = fromBinary(EnvelopeSchema, message.uint8Array())
    } catch {
      peer.close(4002, 'malformed frame')
      return
    }

    conn.lastSeenAt = new Date()
    const { payload } = envelope

    // Before the handshake only Hello is accepted.
    if (!conn.ready && payload.case !== 'hello') {
      peer.close(4003, 'handshake required')
      return
    }

    switch (payload.case) {
      case 'hello': {
        const hello = payload.value
        if (hello.protocolVersion !== PROTOCOL_VERSION) {
          sendFrame(peer, 0, {
            case: 'error',
            value: create(TunnelErrorSchema, { code: 426, message: `protocol ${PROTOCOL_VERSION} required` }),
          })
          peer.close(4004, 'protocol version mismatch')
          return
        }
        conn.ready = true
        conn.daemonVersion = hello.daemonVersion

        await useDb()
          .update(schema.nodes)
          .set({
            lastSeenAt: new Date(),
            daemonVersion: hello.daemonVersion,
            systemInfo: hello.system
              ? {
                  hostname: hello.hostname,
                  sftpPort: hello.sftpPort,
                  os: hello.system.os,
                  arch: hello.system.arch,
                  kernel: hello.system.kernel,
                  memoryTotalBytes: Number(hello.system.memoryTotalBytes),
                  cpuCount: hello.system.cpuCount,
                  dockerVersion: hello.system.dockerVersion,
                }
              : { hostname: hello.hostname, sftpPort: hello.sftpPort },
          })
          .where(eq(schema.nodes.id, nodeId))

        sendFrame(peer, 0, {
          case: 'helloAck',
          value: create(HelloAckSchema, {
            protocolVersion: PROTOCOL_VERSION,
            panelVersion: PANEL_VERSION,
            nodeId,
            serverTimeUnixMs: BigInt(Date.now()),
            heartbeatIntervalS: useRuntimeConfig().tunnel.heartbeatIntervalS,
          }),
        })
        await usePanelHooks().callHook('node.connected', { nodeId, daemonVersion: hello.daemonVersion })
        syncNodeStates(nodeId).catch((err) => console.warn(`[tunnel] state sync for node ${nodeId} failed:`, err))
        break
      }
      case 'ping':
        sendFrame(peer, 0, { case: 'pong', value: create(PongSchema, { sentUnixMs: payload.value.sentUnixMs }) })
        break
      case 'event':
        await handleDaemonEvent(nodeId, payload.value).catch((err) =>
          console.error(`[tunnel] event from node ${nodeId} failed:`, err),
        )
        break
      case 'streamOpen':
        // Daemon-opened stream (e.g. sftp.auth); handled asynchronously.
        handleDaemonStreamOpen(conn, envelope)
        break
      case 'streamData':
      case 'streamClose':
        handleStreamFrame(conn, envelope)
        break
      case 'error':
        if (envelope.streamId !== 0) handleStreamFrame(conn, envelope)
        else console.warn(`[tunnel] node ${nodeId} reported error ${payload.value.code}: ${payload.value.message}`)
        break
      default:
        break
    }
  },

  async close(peer, details) {
    const nodeId = peer.context.nodeId as string | undefined
    if (!nodeId || !unregisterTunnel(nodeId, peer)) return
    console.info(`[tunnel] node ${nodeId} disconnected (${details.code ?? '-'} ${details.reason ?? ''})`)
    await useDb()
      .update(schema.nodes)
      .set({ lastSeenAt: new Date() })
      .where(eq(schema.nodes.id, nodeId))
      .catch(() => {})
    await markNodeServersUnknown(nodeId).catch(() => {})
    await usePanelHooks().callHook('node.disconnected', { nodeId })
  },
})
