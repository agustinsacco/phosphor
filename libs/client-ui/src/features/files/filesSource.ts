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
}

/** One lane's files, as the Files pane reads and writes them. */
export interface FilesSource {
  /** The files store key: a local folder or a Host lane's `host:` key; IPC routes by it. */
  workspacePath: string
  /** Why the files cannot be read now, or null. */
  unavailable: string | null
  /** Why this device cannot write them now, or null. */
  writeRefusal: string | null
  /** `tree` reads a directory per `fs:readDir`; `flat` lists every file once and folds it. */
  listing: 'tree' | 'flat'
  /** Changes when the files may have changed without a watcher event. */
  refreshKey: string
  features: FilesFeatures
}

const LOCAL_FEATURES: FilesFeatures = {
  watch: true,
  search: true,
  mediaPreview: true,
  osActions: true,
  listOptions: true,
  clipboardFiles: true,
}

const HOST_FEATURES: FilesFeatures = {
  watch: false,
  search: false,
  mediaPreview: false,
  osActions: false,
  listOptions: false,
  clipboardFiles: false,
}

/** A folder on this device. */
export function useLocalFilesSource(workspacePath: string): FilesSource {
  return {
    workspacePath,
    unavailable: null,
    writeRefusal: null,
    listing: 'tree',
    refreshKey: '',
    features: LOCAL_FEATURES,
  }
}

/** A Host lane: read and written through its Host, refreshed when the lane or connection moves. */
export function useHostFilesSource(sessionId: string, workspacePath: string): FilesSource {
  const target = useSessionsStore((s) => s.live[sessionId]?.target)
  const laneId = useSessionsStore((s) => s.live[sessionId]?.laneId)
  const host = useRemoteLanesStore((s) =>
    target?.kind === 'remote' ? s.hosts[target.hostId] : undefined,
  )
  const writeRefusal = useLaneWriteRefusal(sessionId)
  return {
    workspacePath,
    unavailable: hostFeatureRefusal(host, 'workspaces.read') ?? null,
    writeRefusal: writeRefusal ?? null,
    listing: 'flat',
    // The Host object is replaced by unrelated lanes and stream updates; only this lane's
    // summary, the connection and the Host runtime say the files may have changed.
    refreshKey: JSON.stringify([
      host?.lanes.find((lane) => lane.laneId === laneId),
      host?.state,
      host?.connectionToken,
      host?.cursor?.epoch,
    ]),
    features: HOST_FEATURES,
  }
}
