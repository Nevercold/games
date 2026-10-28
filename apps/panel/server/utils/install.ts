import { InstallRequestSchema, InstallResponseSchema } from '@panel/protocol'
import { eq } from 'drizzle-orm'

/**
 * Sends the template's install script to the daemon. Without an install
 * hook the server is simply ready (status offline).
 */
export async function startInstall(serverId: string) {
  const loaded = await loadServerForSpec(serverId)
  const install = buildInstallSpec(loaded.template)
  const db = useDb()

  if (!install) {
    await db.update(schema.servers).set({ status: 'offline', statusMessage: null }).where(eq(schema.servers.id, serverId))
    publishServer(serverId, { type: 'status', status: 'offline' })
    return
  }

  const spec = buildServerSpec(loaded)
  // Mark as installing before the RPC: a fast InstallFinished event must not
  // be overwritten afterwards.
  await db.update(schema.servers).set({ status: 'installing', statusMessage: null }).where(eq(schema.servers.id, serverId))
  publishServer(serverId, { type: 'status', status: 'installing' })
  try {
    await rpc(loaded.server.nodeId, 'install', InstallRequestSchema, { spec, install }, InstallResponseSchema)
  } catch (err) {
    const message = err instanceof TunnelError ? err.message : 'install could not be started'
    await db
      .update(schema.servers)
      .set({ status: 'install_failed', statusMessage: `Installation konnte nicht gestartet werden: ${message}` })
      .where(eq(schema.servers.id, serverId))
    publishServer(serverId, { type: 'status', status: 'install_failed', message })
    throw toHttpError(err)
  }
}
