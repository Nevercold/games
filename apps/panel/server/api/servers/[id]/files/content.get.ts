import { FileReadRequestSchema, FileReadResponseSchema } from '@panel/protocol'
import { z } from 'zod'

const params = z.object({ id: z.uuid() })
const query = z.object({ path: filePath })

const MAX_EDITOR_BYTES = 5 * 1024 * 1024

/** File content for the editor. Binary files are reported, not returned. */
export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, params.parse)
  const { path } = await getValidatedQuery(event, query.parse)
  const { server } = await requireServerPermission(event, id, 'file.read-content')
  let res
  try {
    res = await rpc(server.nodeId, 'files.read', FileReadRequestSchema, { serverId: id, path, maxBytes: BigInt(MAX_EDITOR_BYTES) }, FileReadResponseSchema)
  } catch (err) {
    throw toHttpError(err)
  }
  const head = res.content.subarray(0, 8192)
  const binary = head.includes(0)
  if (res.truncated) {
    throw createError({ statusCode: 413, statusMessage: 'file too large for the editor, download it instead' })
  }
  return {
    path,
    size: Number(res.size),
    binary,
    content: binary ? '' : new TextDecoder().decode(res.content),
  }
})
