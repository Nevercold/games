import type { InjectionKey, Ref } from 'vue'

export interface ServerStats {
  cpu: number
  memory: number
  memoryLimit: number
  netRx: number
  netTx: number
  disk: number
  uptimeMs: number
}

export interface ServerSocket {
  status: Ref<string>
  statusMessage: Ref<string | null>
  stats: Ref<ServerStats | null>
  connected: Ref<boolean>
  error: Ref<string | null>
  /** Register an output listener; returns the buffered output so far. */
  onOutput: (fn: (chunk: string) => void) => () => void
  backlog: () => string
  sendCommand: (line: string) => void
}

export const SERVER_SOCKET: InjectionKey<ServerSocket> = Symbol('server-socket')

const MAX_BACKLOG = 256 * 1024

/**
 * Websocket to /api/servers/:id/ws with automatic reconnect. Client-only;
 * on the server it returns inert refs.
 */
export function useServerSocket(serverId: string, initialStatus: string): ServerSocket {
  const status = ref(initialStatus)
  const statusMessage = ref<string | null>(null)
  const stats = ref<ServerStats | null>(null)
  const connected = ref(false)
  const error = ref<string | null>(null)
  const listeners = new Set<(chunk: string) => void>()
  let buffer = ''
  let ws: WebSocket | null = null
  let retry = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let closedByUs = false

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    ws = new WebSocket(`${proto}://${location.host}/api/servers/${serverId}/ws`)
    ws.onopen = () => {
      connected.value = true
      error.value = null
      retry = 0
      // The daemon replays its history on every new console stream.
      buffer = ''
      listeners.forEach((fn) => fn('\x1bc'))
    }
    ws.onmessage = (ev) => {
      let msg: any
      try {
        msg = JSON.parse(ev.data)
      } catch {
        return
      }
      switch (msg.type) {
        case 'output':
          buffer += msg.data
          if (buffer.length > MAX_BACKLOG) buffer = buffer.slice(-MAX_BACKLOG)
          listeners.forEach((fn) => fn(msg.data))
          break
        case 'stats':
          stats.value = msg
          break
        case 'status':
          status.value = msg.status
          if (msg.message !== undefined) statusMessage.value = msg.message
          if (msg.status === 'offline' || msg.status === 'install_failed') stats.value = stats.value ? { ...stats.value, cpu: 0, memory: 0, uptimeMs: 0 } : null
          break
        case 'error':
          error.value = msg.message
          break
      }
    }
    ws.onclose = () => {
      connected.value = false
      ws = null
      if (closedByUs) return
      const delay = Math.min(30_000, 1000 * 2 ** retry++)
      timer = setTimeout(connect, delay)
    }
  }

  if (import.meta.client) {
    onMounted(connect)
    onBeforeUnmount(() => {
      closedByUs = true
      clearTimeout(timer)
      ws?.close()
    })
  }

  return {
    status,
    statusMessage,
    stats,
    connected,
    error,
    onOutput(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    backlog: () => buffer,
    sendCommand(line) {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'command', line }))
    },
  }
}
