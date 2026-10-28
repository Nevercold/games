import { FileOpResponseSchema, FileWriteRequestSchema } from '@panel/protocol'
import { z } from 'zod'

const params = z.object({ id: z.uuid() })
const bodySchema = z.object({
  path: filePath.min(1),
  content: z.string().max(5 * 1024 * 1024),
  /** New file (needs file.create) instead of saving an existing one (file.update). */
  create: z.boolean().default(false),
})

export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, params.parse)
  const body = await readValidatedBody(event, bodySchema.parse)
  const { server } = await requireServerPermission(event, id, body.create ? 'file.create' : 'file.update')
  try {
    await rpc(
      server.nodeId,
      'files.write',
      FileWriteRequestSchema,
      { serverId: id, path: body.path, content: new TextEncoder().encode(body.content), diskLimitBytes: diskLimitBytes(server) },
      FileOpResponseSchema,
    )
  } catch (err) {
    throw toHttpError(err)
  }
  return { ok: true }
})
