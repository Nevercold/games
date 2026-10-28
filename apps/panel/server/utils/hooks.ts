import { createHooks } from 'hookable'

/**
 * Panel-wide hook bus. Core code calls these, plugins subscribe via
 * `ctx.hooks.hook(...)`. Keep payloads plain objects so the contract stays
 * stable for third-party plugins.
 */
export interface PanelHooks {
  'node.connected': (payload: { nodeId: string; daemonVersion: string }) => void | Promise<void>
  'node.disconnected': (payload: { nodeId: string }) => void | Promise<void>
  'server.created': (payload: { serverId: string }) => void | Promise<void>
  'server.deleted': (payload: { serverId: string }) => void | Promise<void>
  'backup.finished': (payload: { serverId: string; backupId: string; success: boolean }) => void | Promise<void>
  'backup.restored': (payload: { serverId: string; backupId: string; success: boolean }) => void | Promise<void>
  'user.created': (payload: { userId: string }) => void | Promise<void>
  'auth.login': (payload: { userId: string }) => void | Promise<void>
}

const hooks = createHooks<PanelHooks>()

export function usePanelHooks() {
  return hooks
}
