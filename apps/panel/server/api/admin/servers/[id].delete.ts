import { DeleteServerRequestSchema, DeleteServerResponseSchema } from '@panel/protocol'
import { eq } from 'drizzle-orm'
import { z } from 'zod'

const params = z.object({ id: z.uuid() })
const query = z.object({
  /** Delete from the panel even if the node is unreachable (leaves files behind). */
  force: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
})

export default defineEventHandler(async (event) => {
  await requireAdminPermission(event, 'admin.servers.delete')
  const { id } = await getValidatedRouterParams(event, params.parse)
  const { force } = await getValidatedQuery(event, query.parse)
  const db = useDb()

  const server = await db.query.servers.findFirst({ where: eq(schema.servers.id, id), columns: { id: true, nodeId: true } })
  if (!server) throw createError({ statusCode: 404, statusMessage: 'server not found' })

  try {
    await rpc(server.nodeId, 'delete', DeleteServerRequestSchema, { serverId: id, deleteFiles: true }, DeleteServerResponseSchema, 60_000)
  } catch (err) {
    if (!force) {
      const e = toHttpError(err) as { statusMessage?: string }
      throw createError({ statusCode: 409, statusMessage: `daemon could not delete the server (${e.statusMessage ?? 'error'}); use force to delete anyway` })
    }
  }

  // Allocations are released via ON DELETE SET NULL.
  await db.delete(schema.servers).where(eq(schema.servers.id, id))
  await usePanelHooks().callHook('server.deleted', { serverId: id })
  setResponseStatus(event, 204)
  return null
})
