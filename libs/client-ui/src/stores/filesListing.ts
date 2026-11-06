import type { StoreApi } from 'zustand'
import { patchWorkspace, type FilesState } from './files'

type SetFiles = StoreApi<FilesState>['setState']
type GetFiles = StoreApi<FilesState>['getState']

function atOrBelow(path: string, root: string): boolean {
  return path === root || path.startsWith(root + '/') || path.startsWith(root + '\\')
}

function parentDir(path: string): string {
  const index = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return index < 0 ? '' : path.slice(0, index)
}

const pollingWorkspaces = new Set<string>()

/** Explorer listing, refresh and git-status actions of the files store. */
export function fileListingActions(
  set: SetFiles,
  get: GetFiles,
): Pick<
  FilesState,
  | 'toggleDir'
  | 'refreshDir'
  | 'refreshChangedPaths'
  | 'refreshLoadedDirs'
  | 'pollWorkspace'
  | 'refreshGitStatus'
  | 'setShowHidden'
  | 'setRespectGitignore'
> {
  return {
    toggleDir: async (workspacePath, dirPath) => {
      const { expanded } = get()
      const isOpen = expanded[dirPath] ?? false
      set((s) => ({ expanded: { ...s.expanded, [dirPath]: !isOpen } }))
      if (!isOpen && !get().entries[dirPath]) {
        await get().refreshDir(workspacePath, dirPath)
      }
    },

    refreshDir: (workspacePath, dirPath) => readDir(set, get, workspacePath, dirPath),

    refreshChangedPaths: async (workspacePath, paths) => {
      const state = get()
      const dirs = new Set(
        paths.map((path) => (path === workspacePath ? workspacePath : parentDir(path))),
      )
      await Promise.all(
        [...dirs]
          .filter((dir) => atOrBelow(dir, workspacePath) && state.entries[dir] !== undefined)
          .map((dir) => get().refreshDir(workspacePath, dir)),
      )
    },

    refreshLoadedDirs: async (workspacePath) => {
      const dirs = new Set([
        workspacePath,
        ...Object.keys(get().entries).filter((dir) => atOrBelow(dir, workspacePath)),
      ])
      await Promise.all([...dirs].map((dir) => get().refreshDir(workspacePath, dir)))
    },

    pollWorkspace: (workspacePath) => pollWorkspace(set, get, workspacePath),

    refreshGitStatus: async (workspacePath) => {
      const gitStatus = await window.phosphor.invoke('git:statusMap', workspacePath)
      set((s) => patchWorkspace(s, workspacePath, (w) => ({ ...w, gitStatus })))
    },

    setShowHidden: (workspacePath, value) => {
      set({ showHidden: value, entries: {}, directoryMtimes: {} })
      void get().refreshDir(workspacePath, workspacePath)
    },

    setRespectGitignore: (workspacePath, value) => {
      set({ respectGitignore: value, entries: {}, directoryMtimes: {} })
      void get().refreshDir(workspacePath, workspacePath)
    },
  }
}

async function readDir(
  set: SetFiles,
  get: GetFiles,
  workspacePath: string,
  dirPath: string,
): Promise<void> {
  const { showHidden, respectGitignore } = get()
  try {
    const list = await window.phosphor.invoke('fs:readDir', workspacePath, dirPath, {
      showHidden,
      respectGitignore,
    })
    set((s) => {
      const entries = { ...s.entries, [dirPath]: list }
      const expanded = { ...s.expanded }
      const directoryMtimes = { ...s.directoryMtimes }
      const nextPaths = new Set(list.map((entry) => entry.path))

      // A removed or moved directory must not leave its old lazy subtree in
      // memory. The row selection derives from these listings, so deleting a
      // selected entry also clears the selection without disturbing one that
      // still exists at the same path.
      for (const old of s.entries[dirPath] ?? []) {
        if (!old.isDirectory || nextPaths.has(old.path)) continue
        for (const key of Object.keys(entries)) {
          if (atOrBelow(key, old.path)) delete entries[key]
        }
        for (const key of Object.keys(expanded)) {
          if (atOrBelow(key, old.path)) delete expanded[key]
        }
        for (const key of Object.keys(directoryMtimes)) {
          if (atOrBelow(key, old.path)) delete directoryMtimes[key]
        }
      }
      return { entries, expanded, directoryMtimes }
    })
  } catch {
    set((s) => ({ entries: { ...s.entries, [dirPath]: [] } }))
  }
}

async function pollWorkspace(set: SetFiles, get: GetFiles, workspacePath: string): Promise<void> {
  if (pollingWorkspaces.has(workspacePath)) return
  pollingWorkspaces.add(workspacePath)
  try {
    const state = get()
    const dirs = [
      workspacePath,
      ...Object.keys(state.entries).filter(
        (dir) => dir !== workspacePath && atOrBelow(dir, workspacePath),
      ),
    ]
    const stats = await window.phosphor.invoke('fs:statDirs', dirs)
    const changed: string[] = []
    set((s) => {
      const directoryMtimes = { ...s.directoryMtimes }
      for (const item of stats) {
        const previous = directoryMtimes[item.path]
        directoryMtimes[item.path] = item.mtimeMs
        // The first observation refreshes too. This repairs a snapshot that
        // went stale while the Files pane (and its push listener) was closed.
        if (item.mtimeMs !== null && previous !== item.mtimeMs) changed.push(item.path)
      }
      return { directoryMtimes }
    })
    await Promise.all(changed.map((dir) => get().refreshDir(workspacePath, dir)))
  } finally {
    pollingWorkspaces.delete(workspacePath)
  }
}
