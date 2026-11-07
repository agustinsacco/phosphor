import { useMemo } from 'react'
import { MAX_TEXT_FILE_BYTES } from '@shared/file-kinds'
import { FILE_LIMITS } from '@shared/host-protocol-files'
import { hostFeatureRefusal } from '@/stores/hostRefusals'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { useSessionsStore } from '@/stores/sessions'
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
}

/** One lane's files, as the Files pane reads and writes them. */
export interface FilesSource {
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
  return useMemo(
    () => ({
      workspacePath,
      pathRoot,
      unavailable,
      writeRefusal,
      listing: 'flat',
      refreshKey,
      textLimitBytes: FILE_LIMITS.textBytes,
      features: HOST_FEATURES,
    }),
    [workspacePath, pathRoot, unavailable, writeRefusal, refreshKey],
  )
}

/** The lane's files on the machine that runs it. */
export function useLaneFilesSource(sessionId: string, workspacePath: string): FilesSource {
  const remote = useSessionsStore((s) => s.live[sessionId]?.target?.kind === 'remote')
  const host = useHostFilesSource(sessionId, workspacePath)
  const local = useMemo(() => localFilesSource(workspacePath), [workspacePath])
  return remote ? host : local
}
