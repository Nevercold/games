import {
  FileCompressRequestSchema,
  FileCompressResponseSchema,
  FileDecompressRequestSchema,
  FileDeleteRequestSchema,
  FileMkdirRequestSchema,
  FileOpResponseSchema,
  FileRenameRequestSchema,
} from '@panel/protocol'
import { z } from 'zod'

const params = z.object({
  id: z.uuid(),
  action: z.enum(['mkdir', 'rename', 'delete', 'compress', 'decompress']),
})

const schemas = {
  mkdir: z.object({ path: filePath.min(1) }),
  rename: z.object({ from: filePath.min(1), to: filePath.min(1) }),
  delete: z.object({ paths: z.array(filePath.min(1)).min(1).max(1000) }),
  compress: z.object({ root: filePath.default('/'), paths: z.array(filePath.min(1)).min(1).max(1000) }),
  decompress: z.object({ root: filePath.default('/'), archive: filePath.min(1) }),
}

const PERMISSION = {
  mkdir: 'file.create',
  rename: 'file.update',
  delete: 'file.delete',
  compress: 'file.archive',
  decompress: 'file.archive',
} as const

/** File operations without a body stream: one route, one permission each. */
export default defineEventHandler(async (event) => {
  const { id, action } = await getValidatedRouterParams(event, params.parse)
  const { server } = await requireServerPermission(event, id, PERMISSION[action])
  const limit = diskLimitBytes(server)
  const node = server.nodeId
  try {
    switch (action) {
      case 'mkdir': {
        const b = await readValidatedBody(event, schemas.mkdir.parse)
        await rpc(node, 'files.mkdir', FileMkdirRequestSchema, { serverId: id, path: b.path }, FileOpResponseSchema)
        return { ok: true }
      }
      case 'rename': {
        const b = await readValidatedBody(event, schemas.rename.parse)
        await rpc(node, 'files.rename', FileRenameRequestSchema, { serverId: id, from: b.from, to: b.to }, FileOpResponseSchema)
        return { ok: true }
      }
      case 'delete': {
        const b = await readValidatedBody(event, schemas.delete.parse)
        await rpc(node, 'files.delete', FileDeleteRequestSchema, { serverId: id, paths: b.paths }, FileOpResponseSchema, 120_000)
        return { ok: true }
      }
      case 'compress': {
        const b = await readValidatedBody(event, schemas.compress.parse)
        const res = await rpc(node, 'files.compress', FileCompressRequestSchema, { serverId: id, root: b.root, paths: b.paths, diskLimitBytes: limit }, FileCompressResponseSchema, 30 * 60_000)
        return { archive: res.archive }
      }
      case 'decompress': {
        const b = await readValidatedBody(event, schemas.decompress.parse)
        await rpc(node, 'files.decompress', FileDecompressRequestSchema, { serverId: id, root: b.root, archive: b.archive, diskLimitBytes: limit }, FileOpResponseSchema, 30 * 60_000)
        return { ok: true }
      }
    }
  } catch (err) {
    throw toHttpError(err)
  }
})
