import { create, toBinary } from '@bufbuild/protobuf'
import { FileTransferOpenSchema } from '@panel/protocol'
import { z } from 'zod'

/** Paths come from the client; the daemon resolves them inside os.Root. */
export const filePath = z.string().max(4096).refine((p) => !p.includes('\0'), 'invalid path')

export function diskLimitBytes(server: { diskMb: number }) {
  return BigInt(server.diskMb) * 1024n * 1024n
}

const UPLOAD_CHUNK = 256 * 1024
/** Unacknowledged chunks in flight (daemon buffers 64 frames per stream). */
const UPLOAD_WINDOW = 16

/**
 * Streams a web ReadableStream into a file on the node with a small window
 * of in-flight chunks, so neither side buffers the whole upload.
 */
export function uploadToNode(
  nodeId: string,
  serverId: string,
  path: string,
  size: number,
  limit: bigint,
  body: ReadableStream<Uint8Array>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let inflight = 0
    let wake: (() => void) | null = null
    let finished = false
    const finish = (err?: Error) => {
      if (finished) return
      finished = true
      wake?.()
      if (err) reject(err)
      else resolve()
    }

    let handle: StreamHandle
    try {
      handle = openStream(
        nodeId,
        'file.upload',
        toBinary(FileTransferOpenSchema, create(FileTransferOpenSchema, { serverId, path, size: BigInt(size), diskLimitBytes: limit })),
        {
          onData(_data, eof) {
            if (eof) return // final reply; onClose follows
            inflight--
            const w = wake
            wake = null
            w?.()
          },
          onClose(err) {
            finish(err)
          },
        },
      )
    } catch (err) {
      return reject(err)
    }

    ;(async () => {
      const reader = body.getReader()
      let pending = new Uint8Array(0)
      const flush = async (chunk: Uint8Array) => {
        while (inflight >= UPLOAD_WINDOW && !finished) {
          await new Promise<void>((r) => (wake = r))
        }
        if (finished) throw new Error('upload aborted')
        inflight++
        handle.send(chunk)
      }
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          const merged = new Uint8Array(pending.length + value.length)
          merged.set(pending)
          merged.set(value, pending.length)
          pending = merged
          while (pending.length >= UPLOAD_CHUNK) {
            await flush(pending.slice(0, UPLOAD_CHUNK))
            pending = pending.slice(UPLOAD_CHUNK)
          }
        }
        if (pending.length) await flush(pending)
        handle.end()
      } catch (err) {
        // finish first: close() triggers onClose without an error.
        finish(err instanceof Error ? err : new Error(String(err)))
        handle.close()
      }
    })()
  })
}

/** Opens a download stream and exposes it as a web ReadableStream. */
export function downloadFromNode(nodeId: string, serverId: string, path: string): ReadableStream<Uint8Array> {
  let handle: StreamHandle | undefined
  return new ReadableStream<Uint8Array>({
    start(controller) {
      handle = openStream(
        nodeId,
        'file.download',
        toBinary(FileTransferOpenSchema, create(FileTransferOpenSchema, { serverId, path })),
        {
          onData(data) {
            if (data.length) controller.enqueue(data)
          },
          onClose(err) {
            if (err) controller.error(err)
            else controller.close()
          },
        },
      )
    },
    cancel() {
      handle?.close()
    },
  })
}

/** RFC 6266 Content-Disposition value for a download. */
export function attachmentHeader(filename: string) {
  const ascii = filename.replace(/[^\x20-\x7e]|["\\]/g, '_')
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`
}
