import { app } from 'electron'
import { basename } from 'node:path/posix'
import { transferFile, type ChunkReader } from '@phosphor/host-client/file-bytes'
import { FILE_BYTES_ERRORS as ERRORS } from '@shared/host-protocol-file-bytes'
import { isFilePath } from '@shared/host-protocol-files'
import { isUuid } from '@shared/control-api'
import type { FileDownloadProgress } from '@shared/ipc'
import { localFileName, saveDownload } from './downloads'

/**
 * A Host lane's file saved into this Mac's Downloads folder. Main owns the
 * transfer: bytes never pass through the renderer, which sees progress pushes
 * on `FILE_DOWNLOAD_PROGRESS` and may cancel. A window's downloads end with it.
 */
export const FILE_DOWNLOAD_PROGRESS = 'hosts:fileDownloadProgress'
const PROGRESS_EVERY_MS = 100
const SAVE_FAILED = 'Could not save into your Downloads folder.'
const FIXED = new Set<string>(Object.values(ERRORS))

export interface DownloadWindow {
  id: number
  send(channel: string, progress: FileDownloadProgress): void
  isDestroyed(): boolean
  once(event: 'destroyed', listener: () => void): unknown
  removeListener(event: 'destroyed', listener: () => void): unknown
}

/** `<window id>:<download id>` → its cancel. */
const active = new Map<string, AbortController>()

/** Fixed text only: a Host's words and local paths never cross IPC. */
function failureText(error: unknown): string {
  if (error instanceof Error && FIXED.has(error.message)) return error.message
  return typeof error === 'object' && error !== null && 'code' in error
    ? SAVE_FAILED
    : ERRORS.failed
}

/** The renderer's request, or null: a lane handle, a lane-relative path and a fresh id. */
export function parseDownloadRequest(
  v: unknown,
): { sessionId: string; path: string; id: string } | null {
  if (typeof v !== 'object' || v === null) return null
  const { sessionId, path, id } = v as Record<string, unknown>
  return typeof sessionId === 'string' && isFilePath(path) && isUuid(id)
    ? { sessionId, path, id }
    : null
}

export async function downloadHostFile(
  sender: DownloadWindow,
  request: { id: string; path: string },
  read: ChunkReader,
): Promise<{ savedTo: string }> {
  const key = `${sender.id}:${request.id}`
  if (active.has(key)) throw new Error(ERRORS.failed)
  const abort = new AbortController()
  const stop = () => abort.abort()
  active.set(key, abort)
  sender.once('destroyed', stop)
  let sentAt = 0
  const onProgress = (received: number, size: number) => {
    const now = Date.now()
    if ((received < size && now - sentAt < PROGRESS_EVERY_MS) || sender.isDestroyed()) return
    sentAt = now
    sender.send(FILE_DOWNLOAD_PROGRESS, { id: request.id, received, size })
  }
  let failure: string
  try {
    const savedTo = await saveDownload(
      app.getPath('downloads'),
      localFileName(basename(request.path)),
      async (handle) => {
        await transferFile(
          read,
          async (bytes, offset) => {
            await handle.write(bytes, 0, bytes.length, offset)
          },
          { signal: abort.signal, onProgress },
        )
      },
    )
    return { savedTo }
  } catch (error) {
    failure = failureText(error)
  } finally {
    active.delete(key)
    sender.removeListener('destroyed', stop)
  }
  // Thrown outside the catch so no cause rides along: only the fixed text crosses IPC.
  throw new Error(failure)
}

/** Cancel one of this window's downloads; another window's ids are not reachable. */
export function cancelHostDownload(windowId: number, id: string): void {
  active.get(`${windowId}:${id}`)?.abort()
}
