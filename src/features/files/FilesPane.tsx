import { memo, useEffect } from 'react'
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels'
import { FileExplorer } from './FileExplorer'
import { EditorPane } from './EditorPane'
import { useFilesStore } from '@/stores/files'
import { dirname } from '@/lib/path'

/** Files region: explorer tree + Monaco editor tabs, with live fs updates. */
export const FilesPane = memo(function FilesPane({
  workspacePath,
}: {
  workspacePath: string
}): React.JSX.Element {
  useEffect(() => {
    void window.phosphor.invoke('fs:watchWorkspace', workspacePath)
    const unsubscribe = window.phosphor.onFsChanged((payload) => {
      if (payload.workspacePath !== workspacePath) return
      const store = useFilesStore.getState()
      void store.handleExternalChanges(workspacePath, payload.paths)
      void store.refreshGitStatus(workspacePath)
      // Refresh expanded dirs that contain changes.
      const dirs = new Set(payload.paths.map(dirname))
      for (const dir of dirs) {
        if (store.entries[dir] !== undefined) void store.refreshDir(workspacePath, dir)
      }
      if (dirs.has(workspacePath)) void store.refreshDir(workspacePath, workspacePath)
    })
    return unsubscribe
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
