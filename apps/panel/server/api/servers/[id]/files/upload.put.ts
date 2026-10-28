import { z } from 'zod'

const params = z.object({ id: z.uuid() })
const query = z.object({ path: filePath.min(1) })

/**
 * Raw request body is streamed to the node in windowed chunks. The size
 * comes from Content-Length so the daemon can reject over-quota uploads
 * before any data is sent.
 */
export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, params.parse)
  const { path } = await getValidatedQuery(event, query.parse)
  const { server } = await requireServerPermission(event, id, 'file.create')

  const length = Number(getRequestHeader(event, 'content-length'))
  if (!Number.isFinite(length) || length < 0) {
    throw createError({ statusCode: 411, statusMessage: 'content-length required' })
  }
  const maxUpload = Number(useRuntimeConfig().maxUploadBytes)
  if (length > maxUpload) {
    throw createError({ statusCode: 413, statusMessage: `upload larger than ${maxUpload} bytes` })
  }
  const body = getRequestWebStream(event) ?? new ReadableStream<Uint8Array>({ start: (c) => c.close() })

  try {
    await uploadToNode(server.nodeId, id, path, length, diskLimitBytes(server), body)
  } catch (err) {
    throw toHttpError(err)
  }
  return { ok: true }
})
