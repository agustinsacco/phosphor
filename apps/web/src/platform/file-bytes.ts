import {
  laneFileReader,
  parseDownloadRequest,
  parseLaneFile,
  readWholeFile,
} from '@phosphor/host-client/file-bytes'
import type { RemoteLanes } from '@phosphor/host-client/remote-lanes'
import { downloadBytes } from '@phosphor/shared/download'
import { isTextPreview, mimeTypeForPath, previewKindForPath } from '@phosphor/shared/file-kinds'
import {
  BROWSER_FILE_BYTES,
  FILE_BYTES_ERRORS as ERRORS,
} from '@phosphor/shared/host-protocol-file-bytes'
import type { FileDownloadProgress } from '@phosphor/shared/ipc'

const PROGRESS_EVERY_MS = 100
const FIXED = new Set<string>(Object.values(ERRORS))
const PREVIEW_REFUSED = 'This file has no preview in a browser.'

type WholeFileRead = (
  sessionId: string,
  path: string,
  options: Parameters<typeof readWholeFile>[1],
) => Promise<Uint8Array<ArrayBuffer>>

/** Fixed text only: a Host's words never reach the UI. */
const failureText = (error: unknown): string =>
  error instanceof Error && FIXED.has(error.message) ? error.message : ERRORS.failed

/**
 * A Host lane's file bytes in this tab, over the lane's Host connection with the chunk reads
 * Desktop's main uses. The tab holds each file in memory, so the reads stop at
 * BROWSER_FILE_BYTES. Nothing is persisted: a download is a Blob handed to the browser's own
 * download, and a preview is a Blob URL the viewer revokes.
 *
 * Previews are images, video and audio only (a viewer shows them in <img>, <video> and
 * <audio>), typed from a fixed table by extension, never from the Host or by sniffing. SVG
 * stays on the sandboxed text path, and a PDF is never read for a preview. One preview read
 * runs per lane: a newer one cancels it.
 */
export function createBrowserFileBytes(ports: {
  lanes: Pick<RemoteLanes, 'onLane'>
  progress: (progress: FileDownloadProgress) => void
}) {
  const downloads = new Map<string, AbortController>()
  const read: WholeFileRead = (sessionId, path, options) =>
    // The tab is window 1: a lane another tab or a closed handle names is refused.
    ports.lanes.onLane(1, sessionId, (c, laneId) =>
      readWholeFile(laneFileReader(c, laneId, path), options),
    )
  const previews = createPreviews(read)
  return {
    async download(value: unknown): Promise<{ savedTo: string }> {
      const request = parseDownloadRequest(value)
      if (!request || downloads.has(request.id)) throw new Error(ERRORS.failed)
      const abort = new AbortController()
      downloads.set(request.id, abort)
      let sentAt = 0
      const onProgress = (received: number, size: number) => {
        const now = Date.now()
        if (received < size && now - sentAt < PROGRESS_EVERY_MS) return
        sentAt = now
        ports.progress({ id: request.id, received, size })
      }
      let failure: string
      try {
        const bytes = await read(request.sessionId, request.path, {
          maxBytes: BROWSER_FILE_BYTES.downloadBytes,
          tooLarge: ERRORS.browserTooLarge,
          signal: abort.signal,
          onProgress,
        })
        if (abort.signal.aborted) throw new Error(ERRORS.cancelled)
        const name = request.path.split('/').pop()!
        downloadBytes(name, bytes)
        return { savedTo: name }
      } catch (error) {
        failure = failureText(error)
      } finally {
        downloads.delete(request.id)
      }
      // Thrown outside the catch so no cause rides along.
      throw new Error(failure)
    },
    cancel(id: string): void {
      downloads.get(id)?.abort()
    },
    previewUrl: previews.previewUrl,
    /** Another owner: every read stops, and every preview this tab made is revoked. */
    clear(): void {
      for (const abort of downloads.values()) abort.abort()
      downloads.clear()
      previews.clear()
    },
  }
}

/** One Blob URL per lane at a time: a newer preview cancels and revokes the one before. */
function createPreviews(read: WholeFileRead) {
  const previews = new Map<string, { abort: AbortController; url?: string }>()
  return {
    async previewUrl(value: unknown): Promise<string> {
      const file = parseLaneFile(value)
      const kind = file && previewKindForPath(file.path)
      if (!file || isTextPreview(file.path) || !['image', 'video', 'audio'].includes(kind ?? ''))
        throw new Error(PREVIEW_REFUSED)
      const previous = previews.get(file.sessionId)
      previous?.abort.abort()
      if (previous?.url) URL.revokeObjectURL(previous.url)
      const entry: { abort: AbortController; url?: string } = { abort: new AbortController() }
      previews.set(file.sessionId, entry)
      try {
        const bytes = await read(file.sessionId, file.path, {
          maxBytes: BROWSER_FILE_BYTES.previewBytes,
          tooLarge: PREVIEW_REFUSED,
          signal: entry.abort.signal,
        })
        if (entry.abort.signal.aborted) throw new Error(ERRORS.cancelled)
        entry.url = URL.createObjectURL(new Blob([bytes], { type: mimeTypeForPath(file.path) }))
        return entry.url
      } catch {
        if (previews.get(file.sessionId) === entry) previews.delete(file.sessionId)
        throw new Error(PREVIEW_REFUSED)
      }
    },
    clear(): void {
      for (const { abort, url } of previews.values()) {
        abort.abort()
        if (url) URL.revokeObjectURL(url)
      }
      previews.clear()
    },
  }
}
