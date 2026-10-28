import { FileReadRequestSchema, FileReadResponseSchema } from '@panel/protocol'
import { z } from 'zod'

const params = z.object({ id: z.uuid() })
const query = z.object({ path: filePath.min(1) })

export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, params.parse)
  const { path } = await getValidatedQuery(event, query.parse)
  const { server } = await requireServerPermission(event, id, 'file.read-content')

  // Check existence and size first: once the body streams, errors can no
  // longer change the status code.
  let size: number
  try {
    const head = await rpc(server.nodeId, 'files.read', FileReadRequestSchema, { serverId: id, path, maxBytes: 1n }, FileReadResponseSchema)
    size = Number(head.size)
  } catch (err) {
    throw toHttpError(err)
  }

  const name = path.split('/').filter(Boolean).pop() ?? 'download'
  setResponseHeaders(event, {
    'content-type': 'application/octet-stream',
    'content-disposition': attachmentHeader(name),
    'content-length': size,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  return sendStream(event, downloadFromNode(server.nodeId, id, path))
})
