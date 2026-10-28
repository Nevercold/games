import { FileOpResponseSchema, ImagePullRequestSchema, ImageRemoveRequestSchema } from '@panel/protocol'
import { z } from 'zod'

const ref = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]{0,254}$/)
const bodySchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('pull'), ref }),
  z.object({ action: z.literal('remove'), id: ref, force: z.boolean().default(false) }),
])

export default defineEventHandler(async (event) => {
  const { nodeId } = await requireDockerNode(event, 'admin.docker.write')
  const body = await readValidatedBody(event, bodySchema.parse)
  try {
    if (body.action === 'pull') {
      await rpc(nodeId, 'docker.image.pull', ImagePullRequestSchema, { ref: body.ref }, FileOpResponseSchema, 30 * 60_000)
    } else {
      await rpc(nodeId, 'docker.image.remove', ImageRemoveRequestSchema, { id: body.id, force: body.force }, FileOpResponseSchema, 60_000)
    }
  } catch (err) {
    throw toHttpError(err)
  }
  return { ok: true }
})
