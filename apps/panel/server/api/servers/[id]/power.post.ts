import { create } from '@bufbuild/protobuf'
import { PowerAction, PowerRequestSchema, PowerResponseSchema, ServerSpecSchema } from '@panel/protocol'
import { POWER_PERMISSION } from '#shared/permissions'
import { z } from 'zod'

const params = z.object({ id: z.uuid() })
const bodySchema = z.object({ action: z.enum(['start', 'stop', 'restart', 'kill']) })

const ACTIONS = {
  start: PowerAction.START,
  stop: PowerAction.STOP,
  restart: PowerAction.RESTART,
  kill: PowerAction.KILL,
} as const

export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, params.parse)
  const { action } = await readValidatedBody(event, bodySchema.parse)
  const { server } = await requireServerPermission(event, id, POWER_PERMISSION[action])

  if (server.status === 'suspended') throw createError({ statusCode: 409, statusMessage: 'server is suspended' })
  if (server.status === 'installing') throw createError({ statusCode: 409, statusMessage: 'server is installing' })
  if (server.status === 'install_failed' && (action === 'start' || action === 'restart')) {
    throw createError({ statusCode: 409, statusMessage: 'installation failed, reinstall the server first' })
  }

  // Start/restart send the full spec so the daemon always runs current settings.
  const spec = action === 'start' || action === 'restart'
    ? buildServerSpec(await loadServerForSpec(id))
    : create(ServerSpecSchema, { id })

  try {
    await rpc(server.nodeId, 'power', PowerRequestSchema, { action: ACTIONS[action], spec }, PowerResponseSchema)
  } catch (err) {
    throw toHttpError(err)
  }
  return { ok: true }
})
