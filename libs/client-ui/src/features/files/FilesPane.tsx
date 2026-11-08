import { memo, useEffect, useLayoutEffect, useRef } from 'react'
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels'
import { FileExplorer } from './FileExplorer'
import { EditorPane } from './EditorPane'
import { WorkspaceSearch } from './WorkspaceSearch'
import { useWorkspaceSearchStore, workspaceSearch } from './workspaceSearchStore'
import { attachFilesSource, useFilesStore, workspaceFiles } from '@/stores/files'
import type { FilesSource } from './filesSource'

const FALLBACK_POLL_MS = 2_000

/**
 * Files region: explorer tree (or, while open, the workspace search in its
 * place) + Monaco editor tabs, with live fs updates where the machine watches.
 */
export const FilesPane = memo(function FilesPane({
  source,
}: {
  source: FilesSource
}): React.JSX.Element {
  const { workspacePath, features, unavailable } = source
  // A layout effect, so the store lists and saves through this source before the explorer's
  // first read (a child's passive effect).
  useLayoutEffect(() => attachFilesSource(source), [source])
  useRefreshOnKey(source)
  useWorkspaceWatch(workspacePath, features.watch)

  const searchOpen = useWorkspaceSearchStore(
    (s) => features.search && workspaceSearch(s, workspacePath).open,
  )
  const explorerFocusRequest = useWorkspaceSearchStore(
    (s) => workspaceSearch(s, workspacePath).explorerFocusRequest,
  )
  const explorerRef = useRef<HTMLDivElement>(null)
  // Closing the search hands focus to the tree that replaces it: the field or
  // button that had it is gone. What was asked before this pane (or this
  // workspace) showed is not asked of it.
  const honouredExplorerFocus = useRef({ workspacePath, request: explorerFocusRequest })
  useLayoutEffect(() => {
    const honoured = honouredExplorerFocus.current
    honouredExplorerFocus.current = { workspacePath, request: explorerFocusRequest }
    if (searchOpen || honoured.workspacePath !== workspacePath) return
    if (honoured.request === explorerFocusRequest) return
    const explorer = explorerRef.current?.firstElementChild
    if (explorer instanceof HTMLElement) explorer.focus()
  }, [workspacePath, searchOpen, explorerFocusRequest])

  const hasOpenFiles = useFilesStore((s) => workspaceFiles(s, workspacePath).openFiles.length > 0)
  // Open buffers stay on screen while the machine is unreachable; nothing else can be shown.
  if (unavailable && !hasOpenFiles) return <p className="p-4">{unavailable}</p>
  return (
    <div className="flex h-full min-h-0 flex-col">
      {unavailable && (
        <p role="status" className="text-text-tertiary border-border border-b px-3 py-2 text-sm">
          {unavailable} Unsaved edits are kept.
        </p>
      )}
      <PanelGroup direction="horizontal" autoSaveId={`phosphor-files-${workspacePath}`}>
        <Panel defaultSize={32} minSize={16} className="bg-bg-secondary/40">
          {searchOpen ? (
            <WorkspaceSearch workspacePath={workspacePath} />
          ) : (
            <div ref={explorerRef} className="contents">
              <FileExplorer source={source} />
            </div>
          )}
        </Panel>
        <PanelResizeHandle className="pane-handle" />
        <Panel minSize={30}>
          <EditorPane source={source} />
        </Panel>
      </PanelGroup>
    </div>
  )
})

/**
 * Re-read the tree and git status when the source's refresh key moves (a Host lane's summary,
 * connection or runtime), never on mount: the explorer reads then.
 */
function useRefreshOnKey({ workspacePath, refreshKey, unavailable }: FilesSource): void {
  const seen = useRef({ workspacePath, refreshKey })
  useEffect(() => {
    const last = seen.current
    if (unavailable || (last.workspacePath === workspacePath && last.refreshKey === refreshKey))
      return
    seen.current = { workspacePath, refreshKey }
    if (last.workspacePath !== workspacePath) return
    const store = useFilesStore.getState()
    void store.refreshLoadedDirs(workspacePath)
    void store.refreshGitStatus(workspacePath)
  }, [workspacePath, refreshKey, unavailable])
}

/** Live updates where the machine watches: the watcher's batches, and a directory poll behind it. */
function useWorkspaceWatch(workspacePath: string, watch: boolean): void {
  useEffect(() => {
    if (!watch) return
    const store = useFilesStore.getState()
    void window.phosphor.invoke('fs:watchWorkspace', workspacePath)
    const unsubscribe = window.phosphor.onFsChanged((payload) => {
      if (payload.workspacePath !== workspacePath) return
      const current = useFilesStore.getState()
      void current.handleExternalChanges(workspacePath, payload.paths)
      void current.refreshGitStatus(workspacePath)
      void current.refreshChangedPaths(workspacePath, payload.paths)
    })

    // Chokidar is the fast path. Directory mtimes are a cheap safety net for
    // unavailable/exhausted native watchers and for events emitted while this
    // pane was closed. Only a changed loaded directory is re-read.
    void store.pollWorkspace(workspacePath)
    const poll = window.setInterval(
      () => void useFilesStore.getState().pollWorkspace(workspacePath),
      FALLBACK_POLL_MS,
    )
    return () => {
      window.clearInterval(poll)
      unsubscribe()
    }
  }, [workspacePath, watch])
}
