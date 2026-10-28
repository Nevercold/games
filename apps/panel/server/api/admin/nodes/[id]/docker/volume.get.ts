import { FileListResponseSchema, FileReadResponseSchema, VolumeListRequestSchema, VolumeReadRequestSchema } from '@panel/protocol'
import { z } from 'zod'

const query = z.object({
  volume: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,254}$/),
  path: filePath.default('/'),
  /** "list" a directory or "read" a file (first MiB). */
  op: z.enum(['list', 'read']).default('list'),
})

/** Read-only volume browser (runs a throwaway helper container on the node). */
export default defineEventHandler(async (event) => {
  const { nodeId } = await requireDockerNode(event, 'admin.docker.read')
  const q = await getValidatedQuery(event, query.parse)
  try {
    if (q.op === 'list') {
      const res = await rpc(nodeId, 'docker.volume.list', VolumeListRequestSchema, { volume: q.volume, path: q.path }, FileListResponseSchema, 60_000)
      return {
        entries: res.entries
          .map((e) => ({ name: e.name, size: Number(e.size), modified: Number(e.modifiedUnix), isDir: e.isDir, isSymlink: e.isSymlink }))
          .sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name)),
      }
    }
    const res = await rpc(nodeId, 'docker.volume.read', VolumeReadRequestSchema, { volume: q.volume, path: q.path, maxBytes: 1024n * 1024n }, FileReadResponseSchema, 60_000)
    const binary = res.content.subarray(0, 8192).includes(0)
    return { content: binary ? '' : new TextDecoder().decode(res.content), binary, truncated: res.truncated }
  } catch (err) {
    throw toHttpError(err)
  }
})
