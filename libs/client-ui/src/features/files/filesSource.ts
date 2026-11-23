import { useMemo } from 'react'
import { MAX_TEXT_FILE_BYTES } from '@shared/file-kinds'
import { FILE_LIMITS } from '@shared/host-protocol-files'
import {
  BROWSER_FILE_BYTES,
  FILE_BYTES_ERRORS,
  FILE_BYTES_LIMITS,
} from '@shared/host-protocol-file-bytes'
import { hostFeatureRefusal } from '@/stores/hostRefusals'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { useSessionsStore } from '@/stores/sessions'
import { usePlatform } from '@/platform/Platform'
import { useLaneWriteRefusal } from './laneWriteRefusal'

/** What a lane's machine offers the Files pane beyond reading and writing its files. */
export interface FilesFeatures {
  /** A filesystem watcher and directory polling keep the tree current. */
  watch: boolean
  /** Search in files. */
  search: boolean
  /** Images, media, PDFs and rendered HTML over `phosphor-file://`. */
  mediaPreview: boolean
  /** Reveal, Quick Look and Open in default app. */
  osActions: boolean
  /** The hidden-files and .gitignore toggles. */
  listOptions: boolean
  /** File copy/cut/paste and import through the OS clipboard, a picker or a drop. */
  clipboardFiles: boolean
  /** Revert a changed file to the session's start. */
  revert: boolean
  /**
   * Save a Host lane's file on this device, through `sessionId`: into its Downloads folder
   * where files save natively, as a browser download in a browser.
   */
  download: boolean
  /** Open a finished download in its default app, and reveal it: where files save natively. */
  openDownloads: boolean
  /**
   * Images and media from a Host, through `sessionId`: streamed over `phosphor-file://` as the
   * viewer reads them, or in a browser read whole into a Blob; null where the Host sends no bytes.
   */
  hostPreview: 'stream' | 'blob' | null
}

/** One lane's files, as the Files pane reads and writes them. */
export interface FilesSource {
  /** A Host lane's handle, which downloads name; absent for a folder on this device. */
  sessionId?: string
  /** The files store key: a local folder or a Host lane's `host:` key; IPC routes by it. */
  workspacePath: string
  /** The folder the lane's tools name paths in: the folder itself, or the Host lane's cwd. */
  pathRoot: string
  /** Why the files cannot be read now, or null. */
  unavailable: string | null
  /** Why this device cannot write them now, or null. */
  writeRefusal: string | null
  /** `tree` reads a directory per `fs:readDir`; `flat` lists every file once and folds it. */
  listing: 'tree' | 'flat'
  /** Changes when the files may have changed without a watcher event. */
  refreshKey: string
  /** The largest file the machine reads as text. */
  textLimitBytes: number
  /**
   * The largest Host file this device downloads, with the refusal for a larger one, and the
   * largest it previews from its bytes.
   */
  byteLimits: { download: number; tooLarge: string; preview: number }
  features: FilesFeatures
}

const LOCAL_FEATURES: FilesFeatures = {
  watch: true,
  search: true,
  mediaPreview: true,
  osActions: true,
  listOptions: true,
  clipboardFiles: true,
  revert: true,
  download: false,
  openDownloads: false,
  hostPreview: null,
}

// Revert needs a session baseline the Host does not keep yet (E6).
const HOST_FEATURES: FilesFeatures = {
  watch: false,
  search: false,
  mediaPreview: false,
  osActions: false,
  listOptions: false,
  clipboardFiles: false,
  revert: false,
  download: false,
  openDownloads: false,
  hostPreview: null,
}
// A Host that serves file bytes, to a device that saves and streams them natively, or to a
// browser, which holds each file in memory.
const NATIVE_BYTES_FEATURES: FilesFeatures = {
  ...HOST_FEATURES,
  download: true,
  openDownloads: true,
  hostPreview: 'stream',
}
const BROWSER_BYTES_FEATURES: FilesFeatures = {
  ...HOST_FEATURES,
  download: true,
  hostPreview: 'blob',
}
const NATIVE_BYTE_LIMITS = {
  download: FILE_BYTES_LIMITS.fileBytes,
  tooLarge: FILE_BYTES_ERRORS.tooLarge,
  preview: FILE_BYTES_LIMITS.fileBytes,
}
const BROWSER_BYTE_LIMITS = {
  download: BROWSER_FILE_BYTES.downloadBytes,
  tooLarge: FILE_BYTES_ERRORS.browserTooLarge,
  preview: BROWSER_FILE_BYTES.previewBytes,
}

/** A folder on this device; it holds no state, so it is not a hook. */
export function localFilesSource(workspacePath: string): FilesSource {
  return {
    workspacePath,
    pathRoot: workspacePath,
    unavailable: null,
    writeRefusal: null,
    listing: 'tree',
    refreshKey: '',
    textLimitBytes: MAX_TEXT_FILE_BYTES,
    byteLimits: NATIVE_BYTE_LIMITS,
    features: LOCAL_FEATURES,
  }
}

/** A Host lane: read and written through its Host, refreshed when the lane or connection moves. */
export function useHostFilesSource(sessionId: string, workspacePath: string): FilesSource {
  const target = useSessionsStore((s) => s.live[sessionId]?.target)
  const laneId = useSessionsStore((s) => s.live[sessionId]?.laneId)
  // The Host object is replaced by unrelated lanes and stream updates: select only strings, so the
  // source, and the memos of the panes it feeds, change when this lane's files may have.
  const hostOf = (s: ReturnType<typeof useRemoteLanesStore.getState>) =>
    target?.kind === 'remote' ? s.hosts[target.hostId] : undefined
  const laneOf = (s: ReturnType<typeof useRemoteLanesStore.getState>) =>
    hostOf(s)?.lanes.find((l) => l.laneId === laneId)
  const pathRoot = useRemoteLanesStore((s) => laneOf(s)?.cwd) ?? workspacePath
  const unavailable = useRemoteLanesStore(
    (s) => hostFeatureRefusal(hostOf(s), 'workspaces.read') ?? null,
  )
  // This lane's summary, the connection and the Host runtime say the files may have changed.
  const refreshKey = useRemoteLanesStore((s) => {
    const host = hostOf(s)
    return JSON.stringify([laneOf(s), host?.state, host?.connectionToken, host?.cursor?.epoch])
  })
  const writeRefusal = useLaneWriteRefusal(sessionId) ?? null
  const native = usePlatform().nativeFiles
  const local =
    useRemoteLanesStore((s) => hostOf(s)?.local === true && laneOf(s) !== undefined) && native
  const served = useRemoteLanesStore((s) => hostOf(s)?.fileBytes === true)
  return useMemo(
    (): FilesSource =>
      local && !unavailable
        ? { ...localFilesSource(workspacePath), pathRoot, refreshKey }
        : {
            sessionId,
            workspacePath,
            pathRoot,
            unavailable,
            writeRefusal,
            listing: 'flat',
            refreshKey,
            textLimitBytes: FILE_LIMITS.textBytes,
            byteLimits: native ? NATIVE_BYTE_LIMITS : BROWSER_BYTE_LIMITS,
            features: !served
              ? HOST_FEATURES
              : native
                ? NATIVE_BYTES_FEATURES
                : BROWSER_BYTES_FEATURES,
          },
    [
      local,
      sessionId,
      workspacePath,
      pathRoot,
      unavailable,
      writeRefusal,
      refreshKey,
      native,
      served,
    ],
  )
}

/** The lane's files on the machine that runs it. */
export function useLaneFilesSource(sessionId: string, workspacePath: string): FilesSource {
  const remote = useSessionsStore((s) => s.live[sessionId]?.target?.kind === 'remote')
  const host = useHostFilesSource(sessionId, workspacePath)
  const local = useMemo(() => localFilesSource(workspacePath), [workspacePath])
  return remote ? host : local
}
