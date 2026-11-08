import type { ChunkReader } from '@phosphor/host-client/file-bytes'
import { FILE_BYTES_LIMITS } from '@shared/host-protocol-file-bytes'
import { isTextPreview, previewKindForPath } from '@shared/file-kinds'

/** A Host file a preview grant streams: how to read it, and its size and version when granted. */
export interface RemoteFile {
  read: ChunkReader
  size: number
  version: string
}

/** Media and PDFs; HTML, SVG and markdown preview from the text the Host already sent. */
export function streamsFromHost(path: string): boolean {
  const kind = previewKindForPath(path)
  return (
    !isTextPreview(path) &&
    (kind === 'image' || kind === 'video' || kind === 'audio' || kind === 'pdf')
  )
}

/** The file as it is now: a zero-length read answers its size and version. */
export async function openRemoteFile(read: ChunkReader): Promise<RemoteFile> {
  const head = await read(0, 0)
  return { read, size: head.size, version: head.version }
}

/**
 * Bytes `start`..`end` of a Host file, a chunk per pull. Chromium pulls at its
 * own pace, so a paused video stops reading and a seek drops this stream for a
 * new range; at most two chunks wait ahead. A file that changed since the grant
 * errors the stream rather than splice two versions.
 */
export function remoteBody(
  file: RemoteFile,
  start: number,
  end: number,
): ReadableStream<Uint8Array> {
  let position = start
  return new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        const length = Math.min(FILE_BYTES_LIMITS.chunkBytes, end + 1 - position)
        const chunk = await file.read(position, length)
        if (chunk.version !== file.version || chunk.bytes.length !== length)
          throw new Error('The file changed on its Host.')
        position += length
        controller.enqueue(chunk.bytes)
        if (position > end) controller.close()
      },
    },
    { highWaterMark: 2 },
  )
}
