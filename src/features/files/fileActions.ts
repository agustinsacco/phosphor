import type { DirEntry } from '@shared/models'
import { dirname } from '@/lib/path'
import { useFilesStore, workspaceFiles } from '@/stores/files'
import { promptText } from '@/stores/prompt'
import { useExtensionUiStore } from '@/stores/extensionUi'

export function runFileAction(action: Promise<unknown>): void {
  void action.catch((error) => {
    useExtensionUiStore.getState().pushToast(String(error), 'error')
  })
}

/** Names are single entries, never paths that can escape the selected folder. */
export function entryPath(dir: string, name: string): string {
  if (
    !name.trim() ||
    name === '.' ||
    name === '..' ||
    /[/\\]/.test(name) ||
    [...name].some((c) => c.charCodeAt(0) < 32)
  ) {
    throw new Error('Enter a file or folder name, without path separators.')
  }
  const separator = dir.includes('\\') ? '\\' : '/'
  return dir.replace(/[/\\]$/, '') + separator + name
}

export async function createIn(
  workspacePath: string,
  entry: DirEntry | undefined,
  kind: 'file' | 'folder',
): Promise<void> {
  const dir = entry ? (entry.isDirectory ? entry.path : dirname(entry.path)) : workspacePath
  const name = await promptText({
    title: kind === 'file' ? 'New file' : 'New folder',
    placeholder: 'Name',
  })
  if (!name) return
  const target = entryPath(dir, name)
  if (kind === 'file') await window.pidex.invoke('fs:createFile', target)
  else await window.pidex.invoke('fs:createDir', target)
  const store = useFilesStore.getState()
  if (dir !== workspacePath && !store.expanded[dir]) await store.toggleDir(workspacePath, dir)
  await store.refreshDir(workspacePath, dir)
  if (kind === 'file') await store.openFile(workspacePath, target)
}

export async function renameEntry(workspacePath: string, entry: DirEntry): Promise<void> {
  const name = await promptText({ title: 'Rename', initialValue: entry.name })
  if (!name || name === entry.name) return
  const dir = dirname(entry.path)
  const target = entryPath(dir, name)
  await window.pidex.invoke('fs:rename', entry.path, target)
  useFilesStore.getState().reconcilePath(workspacePath, entry.path, target)
  await useFilesStore.getState().refreshDir(workspacePath, dir)
}

export async function trashEntry(workspacePath: string, entry: DirEntry): Promise<void> {
  const store = useFilesStore.getState()
  const dirty = workspaceFiles(store, workspacePath).openFiles.some(
    (f) =>
      f.dirty &&
      (f.path === entry.path ||
        f.path.startsWith(entry.path + '/') ||
        f.path.startsWith(entry.path + '\\')),
  )
  if (
    !window.confirm(`Move “${entry.name}” to Trash?${dirty ? ' Unsaved edits will be lost.' : ''}`)
  )
    return
  await window.pidex.invoke('fs:trash', entry.path)
  const dir = dirname(entry.path)
  store.reconcilePath(workspacePath, entry.path)
  await store.refreshDir(workspacePath, dir)
}
