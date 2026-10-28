/**
 * Closes tunnels whose daemon stopped sending heartbeats (half-open TCP,
 * frozen host). The daemon reconnects on its own once it is back.
 */
export default defineNitroPlugin((nitro) => {
  const intervalS = useRuntimeConfig().tunnel.heartbeatIntervalS
  const timeoutMs = intervalS * 3 * 1000

  const timer = setInterval(() => {
    const now = Date.now()
    for (const conn of listTunnels()) {
      if (now - conn.lastSeenAt.getTime() > timeoutMs) {
        console.warn(`[tunnel] node ${conn.nodeId} heartbeat timeout, closing`)
        conn.peer.close(4001, 'heartbeat timeout')
      }
    }
  }, intervalS * 1000)

  nitro.hooks.hook('close', () => clearInterval(timer))
})
