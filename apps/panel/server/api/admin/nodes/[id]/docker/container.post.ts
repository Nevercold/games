import { ContainerActionRequestSchema, FileOpResponseSchema } from '@panel/protocol'
import { z } from 'zod'

const bodySchema = z.object({
  container: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/),
  action: z.enum(['start', 'stop', 'restart', 'kill', 'remove']),
})

export default defineEventHandler(async (event) => {
  const { nodeId } = await requireDockerNode(event, 'admin.docker.write')
  const body = await readValidatedBody(event, bodySchema.parse)
  try {
    await rpc(nodeId, 'docker.container', ContainerActionRequestSchema, { containerId: body.container, action: body.action }, FileOpResponseSchema, 60_000)
  } catch (err) {
    throw toHttpError(err)
  }
  return { ok: true }
})
