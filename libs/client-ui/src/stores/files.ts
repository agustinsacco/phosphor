import { create } from 'zustand'
import type { DirEntry } from '@shared/models'
import { isTextPreview } from '@shared/file-kinds'
import { languageForPath } from '@/lib/monaco'
import { keyedSlice } from './keyedSlice'

/**
 * Where to put the cursor in a file being opened: a line, or an exact range
 * (1-based, end exclusive, as Monaco counts).
 */
export interface RevealTarget {
  line: number
  column?: number
  endLine?: number
  endColumn?: number
  /** False leaves keyboard focus where it is — a results list keeps its arrow keys. */
  focus?: boolean
}

/** A reveal waiting for the editor. `seq` makes asking twice for the same place a new request. */
export interface PendingReveal extends RevealTarget {
  seq: number
}

let revealSeq = 0
let fileSeq = 0
const fileWrites = new Map<string, Promise<void>>()
const reopeningWorkspaces = new Set<string>()

export interface OpenFile {
  /** Distinguishes a reopened tab from an earlier asynchronous read/save. */
  instanceId?: number
  path: string
  relativePath: string
  language: string
  /** Disk content at load/save time. */
  savedContent: string
  /** Editor buffer (== savedContent when clean). */
  content: string
  mtimeMs: number
  /** Bytes on disk at load/save time. */
  size: number
  dirty: boolean
  pinned?: boolean
  binary?: boolean
  tooLarge?: boolean
  /** Set when the file changed on disk while dirty (conflict bar). */
  diskConflict?: boolean
  /** The latest place asked for; the editor applies each `seq` once. */
  pendingReveal?: PendingReveal
  /**
   * For files that are both text and previewable (HTML, SVG): which of the
   * two is showing. Absent means the preview — opening one is usually to
   * look at it.
   */
  view?: 'preview' | 'source'
}

/**
 * Editor + git state for ONE workspace. Keyed per workspace so switching to a
 * session in another project shows that project's editors, not the previous
 * one's — a stale editor from another repo is worse than no editor.
 */
interface WorkspaceFiles {
  openFiles: OpenFile[]
  activePath: string | null
  /** Changes on navigation, including reopening the current file. */
  activeRequest?: number
  closedPaths?: string[]
  gitStatus: Record<string, string>
}

/**
 * Slice helpers over `byWorkspace`. The empty value is shared and frozen, so
 * selectors don't allocate a new object per render.
 */
const workspaces = keyedSlice<WorkspaceFiles>({
  openFiles: [],
  activePath: null,
  gitStatus: {},
})

interface FilesState {
  // explorer — keyed by absolute dir path, so already collision-free
  entries: Record<string, DirEntry[] | undefined>
  expanded: Record<string, boolean>
  /** Last directory mtimes seen by the low-frequency watcher fallback. */
  directoryMtimes: Record<string, number | null | undefined>
  showHidden: boolean
  respectGitignore: boolean
  /** workspacePath → that workspace's editors and git status. */
  byWorkspace: Record<string, WorkspaceFiles>

  toggleDir: (workspacePath: string, dirPath: string) => Promise<void>
  refreshDir: (workspacePath: string, dirPath: string) => Promise<void>
  /** Re-read loaded parents named by a debounced watcher batch. */
  refreshChangedPaths: (workspacePath: string, paths: string[]) => Promise<void>
  /** Re-read the root and every loaded directory (manual/tool-result backstop). */
  refreshLoadedDirs: (workspacePath: string) => Promise<void>
  /** Stat loaded directories and re-read only those whose membership may have changed. */
  pollWorkspace: (workspacePath: string) => Promise<void>
  refreshGitStatus: (workspacePath: string) => Promise<void>
  setShowHidden: (workspacePath: string, value: boolean) => void
  setRespectGitignore: (workspacePath: string, value: boolean) => void

  /** Open (or switch to) a file; a target line or range is revealed in the editor. */
  openFile: (workspacePath: string, path: string, target?: number | RevealTarget) => Promise<void>
  closeFile: (workspacePath: string, path: string) => void
  reopenClosed: (workspacePath: string) => Promise<void>
  togglePinned: (workspacePath: string, path: string) => void
  moveTab: (workspacePath: string, path: string, before: string) => void
  /** Retarget open buffers after a move, or close descendants after trash. */
  reconcilePath: (workspacePath: string, from: string, to?: string) => void
  /** Drop a workspace's editors/explorer state and release its Monaco models. */
  releaseWorkspace: (workspacePath: string) => void
  setActive: (workspacePath: string, path: string) => void
  setView: (workspacePath: string, path: string, view: 'preview' | 'source') => void
  updateBuffer: (workspacePath: string, path: string, content: string) => void
  saveFile: (workspacePath: string, path: string) => Promise<void>
  /** Called on chokidar changes: reload clean buffers, flag dirty ones. */
  handleExternalChanges: (workspacePath: string, paths: string[]) => Promise<void>
  reloadFromDisk: (workspacePath: string, path: string) => Promise<void>
  keepBuffer: (workspacePath: string, path: string) => void
}

/** Files state for a workspace; the shared empty value when none exists yet. */
export function workspaceFiles(state: FilesState, workspacePath: string): WorkspaceFiles {
  return workspaces.read(state.byWorkspace, workspacePath)
}

function relativeTo(workspacePath: string, path: string): string {
  const prefix = workspacePath.endsWith('/') ? workspacePath : workspacePath + '/'
  return path.startsWith(prefix) ? path.slice(prefix.length) : path
}

function atOrBelow(path: string, root: string): boolean {
  return path === root || path.startsWith(root + '/') || path.startsWith(root + '\\')
}

function parentDir(path: string): string {
  const index = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return index < 0 ? '' : path.slice(0, index)
}

const pollingWorkspaces = new Set<string>()

/** Apply a patch to one workspace's slice, creating it if absent. */
function patchWorkspace(
  state: FilesState,
  workspacePath: string,
  update: (current: WorkspaceFiles) => WorkspaceFiles,
): Pick<FilesState, 'byWorkspace'> {
  return { byWorkspace: workspaces.patch(state.byWorkspace, workspacePath, update) }
}

/**
 * Replace fields on ONE open file, leaving the rest of the workspace slice
 * alone. `updateBuffer` and `saveFile` derive their new fields from the file
 * they are replacing, so they still map inline.
 */
function patchFile(w: WorkspaceFiles, path: string, fields: Partial<OpenFile>): WorkspaceFiles {
  return {
    ...w,
    openFiles: w.openFiles.map((f) => (f.path === path ? { ...f, ...fields } : f)),
  }
}

export const useFilesStore = create<FilesState>((set, get) => ({
  entries: {},
  expanded: {},
  directoryMtimes: {},
  showHidden: false,
  respectGitignore: true,
  byWorkspace: {},

  toggleDir: async (workspacePath, dirPath) => {
    const { expanded } = get()
    const isOpen = expanded[dirPath] ?? false
    set((s) => ({ expanded: { ...s.expanded, [dirPath]: !isOpen } }))
    if (!isOpen && !get().entries[dirPath]) {
      await get().refreshDir(workspacePath, dirPath)
    }
  },

  refreshDir: async (workspacePath, dirPath) => {
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
  },

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

  pollWorkspace: async (workspacePath) => {
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
  },

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

  openFile: async (workspacePath, path, target) => {
    if (workspacePath.startsWith('host:')) throw new Error('Not available on remote lanes yet.')
    const reveal: Partial<OpenFile> = {}
    if (target !== undefined) {
      reveal.pendingReveal = {
        ...(typeof target === 'number' ? { line: target } : target),
        seq: ++revealSeq,
      }
      // A place in HTML, SVG or markdown is a place in its source.
      if (isTextPreview(path)) reveal.view = 'source'
    }
    const existing = workspaceFiles(get(), workspacePath).openFiles.find((f) => f.path === path)
    if (existing) {
      set((s) =>
        patchWorkspace(s, workspacePath, (w) => ({
          ...patchFile(w, path, reveal),
          activePath: path,
          activeRequest: (w.activeRequest ?? 0) + 1,
        })),
      )
      return
    }
    const file = await window.phosphor.invoke('fs:readFile', path)
    set((s) =>
      patchWorkspace(s, workspacePath, (w) => {
        // Another open of this file can finish during the read (two results in
        // one file, clicked quickly): one tab, at the place asked for last.
        const opened = w.openFiles.find((f) => f.path === path)
        if (opened) {
          const newer = (reveal.pendingReveal?.seq ?? 0) > (opened.pendingReveal?.seq ?? 0)
          return {
            ...(newer ? patchFile(w, path, reveal) : w),
            activePath: path,
            activeRequest: (w.activeRequest ?? 0) + 1,
          }
        }
        const openFile: OpenFile = {
          instanceId: ++fileSeq,
          path,
          relativePath: relativeTo(workspacePath, path),
          language: languageForPath(path),
          savedContent: file.content,
          content: file.content,
          mtimeMs: file.mtimeMs,
          size: file.size,
          dirty: false,
          binary: file.binary,
          tooLarge: file.tooLarge,
          ...reveal,
        }
        return {
          ...w,
          openFiles: [...w.openFiles, openFile],
          activePath: path,
          activeRequest: (w.activeRequest ?? 0) + 1,
        }
      }),
    )
  },

  closeFile: (workspacePath, path) => {
    set((s) =>
      patchWorkspace(s, workspacePath, (w) => {
        const index = w.openFiles.findIndex((f) => f.path === path)
        if (index === -1) return w
        const openFiles = w.openFiles.filter((f) => f.path !== path)
        return {
          ...w,
          openFiles,
          closedPaths: [path, ...(w.closedPaths ?? []).filter((p) => p !== path)].slice(0, 20),
          activePath:
            w.activePath === path
              ? (openFiles[Math.min(index, openFiles.length - 1)]?.path ?? null)
              : w.activePath,
        }
      }),
    )
    // Monaco holds every model in a global registry until disposed, so dropping
    // the store entry alone freed nothing. Lazy import keeps this store free of
    // a dependency on the editor chunk.
    void import('@/features/files/MonacoEditor').then(({ releaseFileModel }) =>
      releaseFileModel(path),
    )
  },

  reopenClosed: async (workspacePath) => {
    if (reopeningWorkspaces.has(workspacePath)) return
    const workspace = workspaceFiles(get(), workspacePath)
    const path = workspace.closedPaths?.find((p) => !workspace.openFiles.some((f) => f.path === p))
    if (!path) return
    // Consume the attempt even if disk access fails. The caller shows the
    // error, and the next request can reach older entries instead of looping.
    set((s) =>
      patchWorkspace(s, workspacePath, (w) => ({
        ...w,
        closedPaths: w.closedPaths?.filter((p) => p !== path),
      })),
    )
    reopeningWorkspaces.add(workspacePath)
    try {
      await get().openFile(workspacePath, path)
    } finally {
      reopeningWorkspaces.delete(workspacePath)
    }
  },

  togglePinned: (workspacePath, path) => {
    set((s) =>
      patchWorkspace(s, workspacePath, (w) => ({
        ...w,
        openFiles: w.openFiles.map((f) => (f.path === path ? { ...f, pinned: !f.pinned } : f)),
      })),
    )
  },

  moveTab: (workspacePath, path, before) => {
    set((s) =>
      patchWorkspace(s, workspacePath, (w) => {
        const file = w.openFiles.find((f) => f.path === path)
        if (!file || path === before || !w.openFiles.some((f) => f.path === before)) return w
        const openFiles = w.openFiles.filter((f) => f.path !== path)
        openFiles.splice(
          openFiles.findIndex((f) => f.path === before),
          0,
          file,
        )
        return { ...w, openFiles }
      }),
    )
  },

  reconcilePath: (workspacePath, from, to) => {
    const matches = (path: string): boolean =>
      path === from || path.startsWith(from + '/') || path.startsWith(from + '\\')
    const paths = workspaceFiles(get(), workspacePath).openFiles.filter((f) => matches(f.path))
    set((s) => ({
      ...patchWorkspace(s, workspacePath, (w) => {
        const openFiles = w.openFiles.flatMap((f) => {
          if (!matches(f.path)) return [f]
          if (!to) return []
          const path = to + f.path.slice(from.length)
          return [
            {
              ...f,
              path,
              relativePath: relativeTo(workspacePath, path),
              language: languageForPath(path),
              // A place asked for in the old file is not one to jump to again
              // when the editor attaches the moved one.
              pendingReveal: undefined,
            },
          ]
        })
        return {
          ...w,
          openFiles,
          closedPaths: w.closedPaths?.flatMap((path) =>
            matches(path) ? (to ? [to + path.slice(from.length)] : []) : [path],
          ),
          activePath:
            w.activePath && matches(w.activePath)
              ? to
                ? to + w.activePath.slice(from.length)
                : (openFiles.at(-1)?.path ?? null)
              : w.activePath,
        }
      }),
      entries: Object.fromEntries(Object.entries(s.entries).filter(([p]) => !matches(p))),
      expanded: Object.fromEntries(Object.entries(s.expanded).filter(([p]) => !matches(p))),
    }))
    if (paths.length)
      void import('@/features/files/MonacoEditor').then(({ releaseFileModel }) => {
        for (const file of paths) releaseFileModel(file.path)
      })
  },

  /**
   * Drop a workspace's editor state entirely, releasing its Monaco models.
   *
   * Without this, browsing several projects retained every explorer listing and
   * every file buffer (each held twice: `content` + `savedContent`, plus the
   * Monaco model and its language-worker mirror) for the app's lifetime.
   */
  releaseWorkspace: (workspacePath) => {
    const slice = get().byWorkspace[workspacePath]
    const paths = slice?.openFiles.map((f) => f.path) ?? []
    set((s) => {
      const byWorkspace = { ...s.byWorkspace }
      delete byWorkspace[workspacePath]
      // Explorer listings and expansion flags are keyed by absolute dir path,
      // so they are pruned by prefix rather than by workspace key.
      const prefix = workspacePath.endsWith('/') ? workspacePath : workspacePath + '/'
      const keep = (key: string): boolean => key !== workspacePath && !key.startsWith(prefix)
      const entries = Object.fromEntries(Object.entries(s.entries).filter(([k]) => keep(k)))
      const expanded = Object.fromEntries(Object.entries(s.expanded).filter(([k]) => keep(k)))
      const directoryMtimes = Object.fromEntries(
        Object.entries(s.directoryMtimes).filter(([k]) => keep(k)),
      )
      return { byWorkspace, entries, expanded, directoryMtimes }
    })
    if (paths.length > 0) {
      void import('@/features/files/MonacoEditor').then(({ releaseFileModel }) => {
        for (const path of paths) releaseFileModel(path)
      })
    }
  },

  setActive: (workspacePath, path) => {
    set((s) =>
      patchWorkspace(s, workspacePath, (w) => ({
        ...w,
        activePath: path,
        activeRequest: (w.activeRequest ?? 0) + 1,
      })),
    )
  },

  setView: (workspacePath, path, view) => {
    set((s) => patchWorkspace(s, workspacePath, (w) => patchFile(w, path, { view })))
  },

  updateBuffer: (workspacePath, path, content) => {
    set((s) =>
      patchWorkspace(s, workspacePath, (w) => ({
        ...w,
        openFiles: w.openFiles.map((f) =>
          f.path === path ? { ...f, content, dirty: content !== f.savedContent } : f,
        ),
      })),
    )
  },

  saveFile: async (workspacePath, path) => {
    const file = workspaceFiles(get(), workspacePath).openFiles.find((f) => f.path === path)
    if (!file || !file.dirty) return
    // Serialize writes to the same disk path, but capture each requested revision
    // now. A later keystroke must never be marked saved by an earlier write.
    const write = (fileWrites.get(path) ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        const { mtimeMs } = await window.phosphor.invoke('fs:writeFile', path, file.content)
        set((s) =>
          patchWorkspace(s, workspacePath, (w) => ({
            ...w,
            openFiles: w.openFiles.map((f) =>
              f.path === path && f.instanceId === file.instanceId
                ? {
                    ...f,
                    savedContent: file.content,
                    dirty: f.content !== file.content,
                    mtimeMs,
                    size: new TextEncoder().encode(file.content).length,
                    diskConflict: false,
                  }
                : f,
            ),
          })),
        )
      })
    fileWrites.set(path, write)
    try {
      await write
    } finally {
      if (fileWrites.get(path) === write) fileWrites.delete(path)
    }
  },

  handleExternalChanges: async (workspacePath, paths) => {
    const changed = new Set(paths)
    const affected = workspaceFiles(get(), workspacePath).openFiles.filter((f) =>
      changed.has(f.path),
    )
    for (const file of affected) {
      if (file.dirty) {
        set((s) =>
          patchWorkspace(s, workspacePath, (w) => patchFile(w, file.path, { diskConflict: true })),
        )
      } else {
        await get().reloadFromDisk(workspacePath, file.path)
      }
    }
  },

  reloadFromDisk: async (workspacePath, path) => {
    const original = workspaceFiles(get(), workspacePath).openFiles.find((f) => f.path === path)
    if (!original) return
    try {
      const file = await window.phosphor.invoke('fs:readFile', path)
      set((s) =>
        patchWorkspace(s, workspacePath, (w) => ({
          ...w,
          openFiles: w.openFiles.map((f) => {
            if (f.path !== path || f.instanceId !== original.instanceId) return f
            // A watcher read may finish after typing or a save. Keep that newer
            // revision and ask the user to resolve the conflict instead.
            if (f.content !== original.content || f.savedContent !== original.savedContent)
              return { ...f, diskConflict: true }
            return {
              ...f,
              savedContent: file.content,
              content: file.content,
              mtimeMs: file.mtimeMs,
              size: file.size,
              binary: file.binary,
              tooLarge: file.tooLarge,
              dirty: false,
              diskConflict: false,
            }
          }),
        })),
      )
    } catch {
      // Deleted externally — keep the buffer, flag the conflict.
      set((s) =>
        patchWorkspace(s, workspacePath, (w) => ({
          ...w,
          openFiles: w.openFiles.map((f) =>
            f.path === path && f.instanceId === original.instanceId
              ? { ...f, diskConflict: true }
              : f,
          ),
        })),
      )
    }
  },

  keepBuffer: (workspacePath, path) => {
    set((s) =>
      patchWorkspace(s, workspacePath, (w) =>
        patchFile(w, path, { diskConflict: false, dirty: true }),
      ),
    )
  },
}))
