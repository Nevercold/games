import { FileListRequestSchema, FileListResponseSchema } from '@panel/protocol'
import { z } from 'zod'

const params = z.object({ id: z.uuid() })
const query = z.object({ path: filePath.default('/') })

export default defineEventHandler(async (event) => {
  const { id } = await getValidatedRouterParams(event, params.parse)
  const { path } = await getValidatedQuery(event, query.parse)
  const { server } = await requireServerPermission(event, id, 'file.read')
  try {
    const res = await rpc(server.nodeId, 'files.list', FileListRequestSchema, { serverId: id, path }, FileListResponseSchema)
    return res.entries
      .filter((e) => !e.name.startsWith('.upload-'))
      .map((e) => ({
        name: e.name,
        size: Number(e.size),
        mode: e.mode,
        modified: Number(e.modifiedUnix),
        isDir: e.isDir,
        isSymlink: e.isSymlink,
      }))
  } catch (err) {
    throw toHttpError(err)
  }
})
