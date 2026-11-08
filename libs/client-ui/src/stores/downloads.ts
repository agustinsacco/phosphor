import { create } from 'zustand'
import { FILE_BYTES_ERRORS } from '@shared/host-protocol-file-bytes'
import { ipcErrorText } from '@shared/errors'
import { basename } from '@/lib/path'

/**
 * Host files being saved into this device's Downloads folder. Main owns each
 * transfer and pushes its progress; this store records what it is told, so the
 * rows survive closing the Files pane and switching lanes.
 */
export interface Download {
  id: string
  /** The lane handle and lane-relative path it came from. */
  sessionId: string
  path: string
  name: string
  received: number
  /** Known once the Host has answered the first chunk. */
  size: number | null
  status: 'running' | 'done' | 'failed'
  /** Where it landed on this device. */
  savedTo?: string
  /** Fixed text from main. */
  error?: string
}

interface DownloadsState {
  items: Download[]
  /**
   * Save a Host lane's file; resolves to where it landed, or null when it did not. One running
   * download per file: a second ask resolves null at once.
   */
  start(sessionId: string, path: string): Promise<string | null>
  cancel(id: string): void
  dismiss(id: string): void
}

/** Finished rows kept on screen; older ones drop off as new downloads start. */
const KEEP_FINISHED = 3

let listening = false

export const useDownloadsStore = create<DownloadsState>((set, get) => {
  const patch = (id: string, change: Partial<Download>) =>
    set((s) => ({ items: s.items.map((d) => (d.id === id ? { ...d, ...change } : d)) }))
  const remove = (id: string) => set((s) => ({ items: s.items.filter((d) => d.id !== id) }))
  return {
    items: [],
    async start(sessionId, path) {
      if (
        get().items.some(
          (d) => d.status === 'running' && d.sessionId === sessionId && d.path === path,
        )
      )
        return null
      if (!listening) {
        listening = true
        window.phosphor.onFileDownloadProgress(({ id, received, size }) =>
          patch(id, { received, size }),
        )
      }
      const id = crypto.randomUUID()
      const row: Download = {
        id,
        sessionId,
        path,
        name: basename(path),
        received: 0,
        size: null,
        status: 'running',
      }
      set((s) => {
        const finished = s.items.filter((d) => d.status !== 'running')
        const drop = new Set(finished.slice(0, Math.max(0, finished.length - KEEP_FINISHED + 1)))
        return { items: [...s.items.filter((d) => !drop.has(d)), row] }
      })
      try {
        const { savedTo } = await window.phosphor.invoke('hosts:fileDownload', {
          sessionId,
          path,
          id,
        })
        patch(id, { status: 'done', savedTo })
        return savedTo
      } catch (error) {
        const text = ipcErrorText(error)
        if (text === FILE_BYTES_ERRORS.cancelled) remove(id)
        else patch(id, { status: 'failed', error: text })
        return null
      }
    },
    cancel(id) {
      window.phosphor.invoke('hosts:fileDownloadCancel', id).catch(() => undefined)
    },
    dismiss: remove,
  }
})
