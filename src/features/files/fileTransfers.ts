import type { DirEntry } from '@shared/models'
import { dirname } from '@/lib/path'
import { useFilesStore } from '@/stores/files'
import { useExtensionUiStore } from '@/stores/extensionUi'

export const FILE_DRAG = 'application/x-pidex-explorer'

export function topLevelPaths(paths: string[]): string[] {
  return [...new Set(paths)].filter(
    (p) =>
      !paths.some(
        (parent) => parent !== p && (p.startsWith(parent + '/') || p.startsWith(parent + '\\')),
      ),
  )
}

/** Process independently: completed moves must reconcile even if a later item fails. */
export async function transferFiles(
  workspace: string,
  paths: string[],
  dir: string,
  cut: boolean,
): Promise<void> {
  const store = useFilesStore.getState()
  const failures: string[] = []
  const remaining: string[] = []
  let completed = 0
  for (const path of topLevelPaths(paths)) {
    try {
      const to = await window.pidex.invoke(
        'fs:transfer',
        workspace,
        path,
        dir,
        cut ? 'move' : 'copy',
      )
      if (cut && to !== path) store.reconcilePath(workspace, path, to)
      if (cut) await store.refreshDir(workspace, dirname(path))
      completed++
    } catch (error) {
      remaining.push(path)
      failures.push(`${path}: ${String(error)}`)
    }
  }
  await store.refreshDir(workspace, dir)
  if (dir !== workspace && !store.expanded[dir]) await store.toggleDir(workspace, dir)
  useExtensionUiStore
    .getState()
    .pushToast(
      failures.length
        ? `${completed} completed; ${failures.length} failed.\n${failures.join('\n')}`
        : `${completed} item${completed === 1 ? '' : 's'} ${cut ? 'moved' : 'copied'}.`,
      failures.length ? 'error' : 'info',
    )
  if (cut) {
    // Do not clear a newer clipboard copied during a slow transfer (or an unrelated drag).
    const clipboard = await window.pidex.invoke('clipboard:readFiles')
    if (clipboard.cut && JSON.stringify(clipboard.paths) === JSON.stringify(paths)) {
      await window.pidex.invoke('clipboard:writeFiles', remaining, true)
    }
  }
}

export function entryDirectory(workspace: string, entry?: DirEntry): string {
  return entry ? (entry.isDirectory ? entry.path : dirname(entry.path)) : workspace
}

export async function pasteFiles(workspace: string, dir: string): Promise<void> {
  const clipboard = await window.pidex.invoke('clipboard:readFiles')
  if (!clipboard.paths.length)
    throw new Error('Copy files in the explorer or your file manager first.')
  await transferFiles(workspace, clipboard.paths, dir, clipboard.cut)
}

export async function importFiles(
  workspace: string,
  dir: string,
  kind: 'file' | 'folder',
): Promise<void> {
  const paths = await window.pidex.invoke('fs:pickEntries', kind)
  if (paths.length) await transferFiles(workspace, paths, dir, false)
}
