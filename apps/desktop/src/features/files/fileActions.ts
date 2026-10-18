import type { DirEntry } from '@shared/models'
import { dirname } from '@/lib/path'
import { useFilesStore, workspaceFiles } from '@/stores/files'
import { promptChoice, promptText } from '@/stores/prompt'
import type { TouchedFile } from './collectTouchedFiles'
import { reconstructOriginal } from './patch'
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
  if (kind === 'file') await window.phosphor.invoke('fs:createFile', target)
  else await window.phosphor.invoke('fs:createDir', target)
  const store = useFilesStore.getState()
  if (dir !== workspacePath && !store.expanded[dir]) await store.toggleDir(workspacePath, dir)
  await store.refreshDir(workspacePath, dir)
  // Reveal line 1: a just-created file is for typing, so it opens in the
  // editor — not, for markdown/HTML/SVG, as a blank preview.
  if (kind === 'file') await store.openFile(workspacePath, target, 1)
}

export async function renameEntry(workspacePath: string, entry: DirEntry): Promise<void> {
  const name = await promptText({ title: 'Rename', initialValue: entry.name })
  if (!name || name === entry.name) return
  const dir = dirname(entry.path)
  const target = entryPath(dir, name)
  await window.phosphor.invoke('fs:rename', entry.path, target)
  useFilesStore.getState().reconcilePath(workspacePath, entry.path, target)
  await useFilesStore.getState().refreshDir(workspacePath, dir)
}

const pendingTrash = new Set<string>()

function hasDirtyDescendants(workspacePath: string, path: string): boolean {
  return workspaceFiles(useFilesStore.getState(), workspacePath).openFiles.some(
    (f) =>
      f.dirty &&
      (f.path === path || f.path.startsWith(path + '/') || f.path.startsWith(path + '\\')),
  )
}

export async function trashEntry(workspacePath: string, entry: DirEntry): Promise<void> {
  const path = entry.path
  const key = JSON.stringify([workspacePath, path])
  if (pendingTrash.has(key)) return
  pendingTrash.add(key)
  try {
    const dirty = hasDirtyDescendants(workspacePath, path)
    const confirm = (warn: boolean) =>
      promptChoice({
        title: `Move “${entry.name}” to Trash?`,
        message: warn ? 'Unsaved edits will be lost.' : undefined,
        choices: [{ value: 'trash', label: 'Move to Trash', primary: true }],
      })
    if ((await confirm(dirty)) !== 'trash') return
    // A clean entry may gain an unsaved buffer while the choice is queued.
    if (!dirty && hasDirtyDescendants(workspacePath, path) && (await confirm(true)) !== 'trash')
      return
    if (entry.path !== path) return
    await window.phosphor.invoke('fs:trash', path)
    const store = useFilesStore.getState()
    store.reconcilePath(workspacePath, path)
    await store.refreshDir(workspacePath, dirname(path))
  } finally {
    pendingTrash.delete(key)
  }
}

function assertCleanBuffer(workspacePath: string, relativePath: string): void {
  // Explorer paths use native separators; agent paths may use forward slashes.
  const absolute = `${workspacePath.replace(/[/\\]+$/, '')}/${relativePath}`.replace(/\\/g, '/')
  if (
    workspaceFiles(useFilesStore.getState(), workspacePath).openFiles.some(
      (f) => f.path.replace(/\\/g, '/') === absolute && f.dirty,
    )
  )
    throw new Error('Save or discard the unsaved editor buffer before reverting this file.')
}

export async function revertFile(
  workspacePath: string,
  file: TouchedFile,
  baselineRef: string | null,
  isCurrent: () => boolean,
): Promise<void> {
  assertCleanBuffer(workspacePath, file.relativePath)
  const choice = await promptChoice({
    title: `Revert ${file.relativePath} to its state at session start?`,
    message: 'Current on-disk edits will be discarded.',
    choices: [{ value: 'revert', label: 'Revert', primary: true }],
  })
  if (choice !== 'revert' || !isCurrent()) return
  assertCleanBuffer(workspacePath, file.relativePath)
  if (baselineRef) {
    await window.phosphor.invoke('git:restoreFileTo', workspacePath, baselineRef, file.relativePath)
  } else if (file.created) {
    throw new Error('Cannot safely revert a write without a saved baseline.')
  } else if (file.patches.length > 0) {
    const path = `${workspacePath}/${file.relativePath}`
    const current = await window.phosphor.invoke('fs:readFile', path)
    if (!isCurrent()) return
    assertCleanBuffer(workspacePath, file.relativePath)
    await window.phosphor.invoke(
      'fs:writeFile',
      path,
      reconstructOriginal(current.content, file.patches),
    )
  }
}
