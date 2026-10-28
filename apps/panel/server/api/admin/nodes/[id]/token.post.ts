import { eq } from 'drizzle-orm'
import { z } from 'zod'

const params = z.object({ id: z.uuid() })

/** Rotates the node token. The running daemon is disconnected immediately. */
export default defineEventHandler(async (event) => {
  await requireAdminPermission(event, 'admin.nodes.write')
  const { id } = await getValidatedRouterParams(event, params.parse)
  const { secret, hash } = generateNodeSecret()

  const updated = await useDb()
    .update(schema.nodes)
    .set({ tokenHash: hash })
    .where(eq(schema.nodes.id, id))
    .returning({ id: schema.nodes.id })
  if (updated.length === 0) throw createError({ statusCode: 404, statusMessage: 'node not found' })

  getTunnel(id)?.peer.close(4006, 'token rotated')
  return { token: formatNodeToken(id, secret) }
})
