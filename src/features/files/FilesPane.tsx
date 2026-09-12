import { memo, useEffect } from 'react'
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels'
import { FileExplorer } from './FileExplorer'
import { EditorPane } from './EditorPane'
import { useFilesStore } from '@/stores/files'

const FALLBACK_POLL_MS = 2_000

/** Files region: explorer tree + Monaco editor tabs, with live fs updates. */
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

  return (
    <PanelGroup direction="horizontal" autoSaveId={`phosphor-files-${workspacePath}`}>
      <Panel defaultSize={32} minSize={16} className="bg-bg-secondary/40">
        <FileExplorer workspacePath={workspacePath} />
      </Panel>
      <PanelResizeHandle className="pane-handle" />
      <Panel minSize={30}>
        <EditorPane workspacePath={workspacePath} />
      </Panel>
    </PanelGroup>
  )
})
