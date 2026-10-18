import { useEffect } from 'react'
import { useFilesStore, workspaceFiles, type OpenFile } from '@/stores/files'
import { ignoreShortcut, shortcutOverlayOpen } from '@/lib/shortcutContext'
import { closeEditorFile } from './closeEditorFile'
import { runFileAction } from './fileActions'

/** Shortest distinguishing suffix, so two index.ts tabs remain recognizable. */
export function editorTabLabel(file: OpenFile, files: OpenFile[]): string {
  const parts = file.relativePath.split(/[/\\]/)
  for (let count = 1; count < parts.length; count++) {
    const label = parts.slice(-count).join('/')
    if (
      !files.some(
        (other) =>
          other.path !== file.path &&
          other.relativePath.split(/[/\\]/).slice(-count).join('/') === label,
      )
    )
      return label
  }
  return parts.join('/')
}

export async function closeEditorFiles(workspace: string, paths: string[]): Promise<void> {
  for (const path of paths) {
    if (
      workspaceFiles(useFilesStore.getState(), workspace).openFiles.find((f) => f.path === path)
        ?.pinned
    )
      continue
    if (!(await closeEditorFile(workspace, path))) break
  }
}

export async function saveAllEditorFiles(workspace: string): Promise<void> {
  const files = workspaceFiles(useFilesStore.getState(), workspace).openFiles
  for (const file of files) await useFilesStore.getState().saveFile(workspace, file.path)
}

/** Tab commands are scoped to the Files pane, never chat, terminal or a modal. */
export function useEditorTabShortcuts(workspace: string): void {
  useEffect(() => {
    const handle = (event: KeyboardEvent): void => {
      // Save All is the one explicit Alt chord. Do not let that exception
      // consume composition, handled keys, or AltGr-generated text.
      const saveAll =
        (event.metaKey || event.ctrlKey) &&
        event.altKey &&
        !event.shiftKey &&
        event.code === 'KeyS' &&
        !event.defaultPrevented &&
        !event.isComposing &&
        event.keyCode !== 229 &&
        !event.getModifierState('AltGraph') &&
        (event.metaKey || event.key.toLowerCase() === 's')
      if ((ignoreShortcut(event) && !saveAll) || shortcutOverlayOpen()) return
      if (
        event.target !== document.body &&
        !(event.target as HTMLElement)?.closest?.('[data-testid="right-pane"]')
      )
        return
      const store = useFilesStore.getState()
      const files = workspaceFiles(store, workspace)
      const mod = event.metaKey || event.ctrlKey
      let action: (() => void) | undefined
      if (event.ctrlKey && !event.metaKey && !event.altKey && event.code === 'Tab') {
        const index = files.openFiles.findIndex((f) => f.path === files.activePath)
        const next =
          files.openFiles[
            (index + (event.shiftKey ? -1 : 1) + files.openFiles.length) % files.openFiles.length
          ]
        if (next) action = () => store.setActive(workspace, next.path)
      } else if (
        mod &&
        !event.altKey &&
        !event.shiftKey &&
        event.code === 'KeyW' &&
        files.activePath
      ) {
        action = () => runFileAction(closeEditorFile(workspace, files.activePath!))
      } else if (mod && !event.altKey && event.shiftKey && event.code === 'KeyT') {
        action = () => runFileAction(store.reopenClosed(workspace))
      } else if (saveAll) {
        action = () => runFileAction(saveAllEditorFiles(workspace))
      }
      if (action) {
        event.preventDefault()
        event.stopPropagation()
        action()
      }
    }
    window.addEventListener('keydown', handle, true)
    return () => window.removeEventListener('keydown', handle, true)
  }, [workspace])
}
