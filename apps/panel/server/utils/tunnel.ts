import { create, fromBinary, toBinary, type DescMessage, type MessageInitShape, type MessageShape } from '@bufbuild/protobuf'
import { EnvelopeSchema, type Envelope } from '@panel/protocol'
import type { Peer } from 'crossws'

/**
 * In-memory registry of connected daemons and the streams multiplexed over
 * them (PLAN.md "Tunnel-Modell"). One panel instance owns all tunnels;
 * horizontal scaling needs sticky routing or a shared registry later.
 */

export interface StreamHandlers {
  onData?: (data: Uint8Array, eof: boolean) => void
  /** Called once when the stream ends; `error` is set on failure. */
  onClose?: (error?: TunnelError) => void
}

interface OpenStream extends StreamHandlers {
  closed: boolean
}

export interface TunnelConnection {
  nodeId: string
  peer: Peer
  connectedAt: Date
  lastSeenAt: Date
  daemonVersion?: string
  /** Set once the Hello/HelloAck handshake completed. */
  ready: boolean
  /** Next stream id opened by the panel (odd numbers). */
  nextStreamId: number
  streams: Map<number, OpenStream>
}

/** Error from the daemon (or the tunnel itself) with an HTTP-like code. */
export class TunnelError extends Error {
  constructor(
    public code: number,
    message: string,
  ) {
    super(message)
  }
}

const tunnels = new Map<string, TunnelConnection>()

export function registerTunnel(nodeId: string, peer: Peer): TunnelConnection {
  // A node may only hold one tunnel. A new connection replaces the old one,
  // e.g. after a daemon restart before the old socket timed out.
  const existing = tunnels.get(nodeId)
  if (existing && existing.peer.id !== peer.id) {
    failAllStreams(existing, new TunnelError(503, 'tunnel replaced'))
    existing.peer.close(4000, 'replaced by new connection')
  }
  const conn: TunnelConnection = {
    nodeId,
    peer,
    connectedAt: new Date(),
    lastSeenAt: new Date(),
    ready: false,
    nextStreamId: 1,
    streams: new Map(),
  }
  tunnels.set(nodeId, conn)
  return conn
}

/** Removes the tunnel only if `peer` is still the registered one. */
export function unregisterTunnel(nodeId: string, peer: Peer): boolean {
  const conn = tunnels.get(nodeId)
  if (conn?.peer.id !== peer.id) return false
  failAllStreams(conn, new TunnelError(503, 'node disconnected'))
  tunnels.delete(nodeId)
  return true
}

export function getTunnel(nodeId: string) {
  return tunnels.get(nodeId)
}

export function isNodeOnline(nodeId: string) {
  return tunnels.get(nodeId)?.ready === true
}

export function listTunnels() {
  return [...tunnels.values()]
}

export function sendEnvelope(peer: Peer, envelope: Envelope) {
  peer.send(toBinary(EnvelopeSchema, envelope))
}

export function sendFrame(peer: Peer, streamId: number, payload: Envelope['payload']) {
  sendEnvelope(peer, create(EnvelopeSchema, { streamId, payload }))
}

// ---------------------------------------------------------------------------
// Streams
// ---------------------------------------------------------------------------

function readyTunnel(nodeId: string): TunnelConnection {
  const conn = tunnels.get(nodeId)
  if (!conn?.ready) throw new TunnelError(503, 'node is offline')
  return conn
}

export interface StreamHandle {
  id: number
  send: (data: Uint8Array) => void
  close: () => void
}

/** Opens a stream to the daemon of `nodeId`. Throws TunnelError when offline. */
export function openStream(nodeId: string, kind: string, header: Uint8Array, handlers: StreamHandlers): StreamHandle {
  const conn = readyTunnel(nodeId)
  const id = conn.nextStreamId
  conn.nextStreamId += 2
  const stream: OpenStream = { ...handlers, closed: false }
  conn.streams.set(id, stream)
  sendFrame(conn.peer, id, { case: 'streamOpen', value: { $typeName: 'panel.v1.StreamOpen', kind, header } })

  return {
    id,
    send(data) {
      if (stream.closed) return
      sendFrame(conn.peer, id, { case: 'streamData', value: { $typeName: 'panel.v1.StreamData', data, eof: false } })
    },
    close() {
      if (stream.closed) return
      stream.closed = true
      conn.streams.delete(id)
      if (tunnels.get(nodeId) === conn) {
        sendFrame(conn.peer, id, { case: 'streamClose', value: { $typeName: 'panel.v1.StreamClose', code: 0, reason: '' } })
      }
      stream.onClose?.()
    },
  }
}

/** Routes stream frames from the daemon to their handlers. */
export function handleStreamFrame(conn: TunnelConnection, envelope: Envelope) {
  const stream = conn.streams.get(envelope.streamId)
  if (!stream || stream.closed) return
  const finish = (error?: TunnelError) => {
    stream.closed = true
    conn.streams.delete(envelope.streamId)
    stream.onClose?.(error)
  }
  switch (envelope.payload.case) {
    case 'streamData':
      stream.onData?.(envelope.payload.value.data, envelope.payload.value.eof)
      if (envelope.payload.value.eof) finish()
      break
    case 'streamClose':
      finish()
      break
    case 'error':
      finish(new TunnelError(envelope.payload.value.code, envelope.payload.value.message))
      break
  }
}

function failAllStreams(conn: TunnelConnection, error: TunnelError) {
  for (const [id, stream] of conn.streams) {
    stream.closed = true
    conn.streams.delete(id)
    stream.onClose?.(error)
  }
}

/**
 * Typed request/response call: the request travels as stream header, the
 * daemon answers with one data frame (eof) or a TunnelError.
 */
export function rpc<Req extends DescMessage, Res extends DescMessage>(
  nodeId: string,
  method: string,
  reqSchema: Req,
  req: MessageInitShape<Req>,
  resSchema: Res,
  timeoutMs = 15_000,
): Promise<MessageShape<Res>> {
  return new Promise((resolve, reject) => {
    let settled = false
    let response: Uint8Array | undefined
    const handle = openStream(nodeId, `rpc:${method}`, toBinary(reqSchema, create(reqSchema, req)), {
      onData(data) {
        response = data
      },
      onClose(error) {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (error) return reject(error)
        if (!response) return reject(new TunnelError(502, `empty response for ${method}`))
        try {
          resolve(fromBinary(resSchema, response))
        } catch (err) {
          reject(new TunnelError(502, `malformed response for ${method}: ${(err as Error).message}`))
        }
      },
    })
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      handle.close()
      reject(new TunnelError(504, `${method} timed out`))
    }, timeoutMs)
  })
}

/** Converts tunnel errors into HTTP errors for API handlers. */
export function toHttpError(err: unknown) {
  if (err instanceof TunnelError) {
    const status = err.code >= 400 && err.code < 600 ? err.code : 502
    return createError({ statusCode: status, statusMessage: err.message })
  }
  return err
}
