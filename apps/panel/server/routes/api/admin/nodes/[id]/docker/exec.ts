import { create, toBinary } from '@bufbuild/protobuf'
import { ExecOpenSchema } from '@panel/protocol'
import type { Peer } from 'crossws'
import { eq } from 'drizzle-orm'

/**
 * Interactive terminal into a container (admin.docker.write).
 * Client → server: {"type":"input","data":"..."} | {"type":"resize","cols":n,"rows":n}
 * Server → client: {"type":"output","data":"..."} | {"type":"exit"} | {"type":"error","message":"..."}
 */

interface ExecSession {
  stream?: StreamHandle
  decoder: TextDecoder
}
const sessions = new WeakMap<Peer, ExecSession>()
const CONTAINER_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/
const SHELLS = new Set(['sh', 'bash', 'ash'])

export default defineWebSocketHandler({
  async upgrade(request) {
    const origin = request.headers.get('origin')
    const host = request.headers.get('host')
    if (!origin || !host || new URL(origin).host !== host) throw new Response('origin not allowed', { status: 403 })

    const url = new URL(request.url)
    const nodeId = /\/api\/admin\/nodes\/([0-9a-f-]{36})\/docker\/exec/i.exec(url.pathname)?.[1]
    const container = url.searchParams.get('container') ?? ''
    const shell = url.searchParams.get('shell') ?? 'sh'
    if (!nodeId || !CONTAINER_RE.test(container) || !SHELLS.has(shell)) throw new Response('bad request', { status: 400 })

    let actor: Actor
    try {
      actor = await requireActor(request as unknown as Request)
    } catch {
      throw new Response('unauthorized', { status: 401 })
    }
    if (!actor.adminPermissions.has('admin.docker.write')) throw new Response('forbidden', { status: 403 })
    const node = await useDb().query.nodes.findFirst({ where: eq(schema.nodes.id, nodeId), columns: { dockerManagement: true } })
    if (!node?.dockerManagement) throw new Response('docker management disabled', { status: 403 })

    request.context.nodeId = nodeId
    request.context.container = container
    request.context.shell = shell
    request.context.cols = Number(url.searchParams.get('cols')) || 80
    request.context.rows = Number(url.searchParams.get('rows')) || 24
    console.info(`[docker] ${actor.username} opened a terminal in ${container} on node ${nodeId}`)
  },

  open(peer) {
    const s: ExecSession = { decoder: new TextDecoder() }
    sessions.set(peer, s)
    const send = (msg: unknown) => peer.send(JSON.stringify(msg))
    try {
      s.stream = openStream(
        peer.context.nodeId as string,
        'docker.exec',
        toBinary(ExecOpenSchema, create(ExecOpenSchema, {
          containerId: peer.context.container as string,
          cmd: [peer.context.shell as string],
          cols: peer.context.cols as number,
          rows: peer.context.rows as number,
        })),
        {
          onData: (data) => send({ type: 'output', data: s.decoder.decode(data, { stream: true }) }),
          onClose: (err) => {
            if (err) send({ type: 'error', message: err.message })
            send({ type: 'exit' })
            peer.close(1000, 'exec ended')
          },
        },
      )
    } catch (err) {
      send({ type: 'error', message: err instanceof Error ? err.message : 'exec failed' })
      peer.close(1011, 'exec failed')
    }
  },

  message(peer, message) {
    const s = sessions.get(peer)
    if (!s?.stream) return
    let msg: { type?: string; data?: unknown; cols?: unknown; rows?: unknown }
    try {
      msg = JSON.parse(message.text())
    } catch {
      return
    }
    if (msg.type === 'input' && typeof msg.data === 'string') {
      const bytes = new TextEncoder().encode(msg.data.slice(0, 64 * 1024))
      const frame = new Uint8Array(bytes.length + 1)
      frame[0] = 0
      frame.set(bytes, 1)
      s.stream.send(frame)
    } else if (msg.type === 'resize') {
      const cols = Math.min(Math.max(Number(msg.cols) || 0, 10), 500)
      const rows = Math.min(Math.max(Number(msg.rows) || 0, 5), 300)
      const json = new TextEncoder().encode(JSON.stringify({ Cols: cols, Rows: rows }))
      const frame = new Uint8Array(json.length + 1)
      frame[0] = 1
      frame.set(json, 1)
      s.stream.send(frame)
    }
  },

  close(peer) {
    sessions.get(peer)?.stream?.close()
    sessions.delete(peer)
  },
})
