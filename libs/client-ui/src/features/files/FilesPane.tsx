import { memo, useEffect, useLayoutEffect, useRef } from 'react'
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels'
import { FileExplorer } from './FileExplorer'
import { EditorPane } from './EditorPane'
import { WorkspaceSearch } from './WorkspaceSearch'
import { useWorkspaceSearchStore, workspaceSearch } from './workspaceSearchStore'
import { useFilesStore } from '@/stores/files'

const FALLBACK_POLL_MS = 2_000

/**
 * Files region: explorer tree (or, while open, the workspace search in its
 * place) + Monaco editor tabs, with live fs updates.
 */
export const FilesPane = memo(function FilesPane({
  workspacePath,
}: {
  workspacePath: string
}): React.JSX.Element {
  useEffect(() => {
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
  }, [workspacePath])

  const searchOpen = useWorkspaceSearchStore((s) => workspaceSearch(s, workspacePath).open)
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

  return (
    <PanelGroup direction="horizontal" autoSaveId={`phosphor-files-${workspacePath}`}>
      <Panel defaultSize={32} minSize={16} className="bg-bg-secondary/40">
        {searchOpen ? (
          <WorkspaceSearch workspacePath={workspacePath} />
        ) : (
          <div ref={explorerRef} className="contents">
            <FileExplorer workspacePath={workspacePath} />
          </div>
        )}
      </Panel>
      <PanelResizeHandle className="pane-handle" />
      <Panel minSize={30}>
        <EditorPane workspacePath={workspacePath} />
      </Panel>
    </PanelGroup>
  )
})
