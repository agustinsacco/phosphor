import { create } from 'zustand'
import type { DirEntry, FileContent } from '@shared/models'
import { isFilePath } from '@shared/host-protocol-files'
import { isTextPreview } from '@shared/file-kinds'
import { languageForPath } from '@/lib/languages'
import type { FilesSource } from '@/features/files/filesSource'
import { keyedSlice } from './keyedSlice'
import { REMOTE_UNAVAILABLE } from './remoteLanes'
import { fileListingActions } from './filesListing'
import { fileSaveActions } from './filesSave'
import { fileTabActions } from './filesTabs'

/** Which side of a file that is both text and renderable (HTML, SVG, Markdown) is showing. */
export type FileView = 'preview' | 'source'

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
  /** The revision read or saved; a write is refused when the file moved past it. Absent: unchecked. */
  revision?: string | null
  /** A revision-checked save is in flight; another is not sent until it settles. */
  saving?: boolean
  /** A revision-checked save failed without saying whether it landed; it is never retried. */
  saveUncertain?: boolean
  /** The latest place asked for; the editor applies each `seq` once. */
  pendingReveal?: PendingReveal
  /** Absent means the preview: opening one is usually to look at it. */
  view?: FileView
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
  /** The last git status read failed. */
  gitUnavailable?: boolean
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

export interface FilesState {
  // explorer — keyed by absolute dir path, so already collision-free
  entries: Record<string, DirEntry[] | undefined>
  expanded: Record<string, boolean>
  /** Last directory mtimes seen by the low-frequency watcher fallback. */
  directoryMtimes: Record<string, number | null | undefined>
  showHidden: boolean
  respectGitignore: boolean
  /** workspacePath → that workspace's editors and git status. */
  byWorkspace: Record<string, WorkspaceFiles>
  /** workspacePath → why its flat file list could not be read. */
  listErrors: Record<string, string | undefined>

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
  setView: (workspacePath: string, path: string, view: FileView) => void
  updateBuffer: (workspacePath: string, path: string, content: string) => void
  saveFile: (workspacePath: string, path: string) => Promise<void>
  /** Called on chokidar changes: reload clean buffers, flag dirty ones. */
  handleExternalChanges: (workspacePath: string, paths: string[]) => Promise<void>
  reloadFromDisk: (workspacePath: string, path: string) => Promise<void>
  keepBuffer: (workspacePath: string, path: string) => void
}

/** What the store needs from a workspace's Files source; This Mac's tree until one is attached. */
type FilesSourceTraits = Pick<FilesSource, 'listing' | 'writeRefusal'>
const sourceTraits = new Map<string, FilesSourceTraits>()

/** The Files pane attaches its source, so listing and saving follow the lane's machine. */
export function attachFilesSource({ workspacePath, listing, writeRefusal }: FilesSource): void {
  sourceTraits.set(workspacePath, { listing, writeRefusal })
}

export function filesSourceTraits(workspacePath: string): FilesSourceTraits {
  return sourceTraits.get(workspacePath) ?? { listing: 'tree', writeRefusal: null }
}

/**
 * A path a Host lane's transcript names, as the lane's file key: relative to the lane, under its
 * cwd, or already under its `host:` key. Anything else, including `..` and `.git`, is refused.
 */
export function laneFilePath(cwd: string, workspace: string, path: string): string {
  const relative = path.startsWith('host:')
    ? path.startsWith(`${workspace}/`)
      ? path.slice(workspace.length + 1)
      : null
    : path.startsWith('/')
      ? path.startsWith(`${cwd}/`)
        ? path.slice(cwd.length + 1)
        : null
      : path
  if (!isFilePath(relative)) throw new Error(REMOTE_UNAVAILABLE)
  return `${workspace}/${relative}`
}

/** Files state for a workspace; the shared empty value when none exists yet. */
export function workspaceFiles(state: FilesState, workspacePath: string): WorkspaceFiles {
  return workspaces.read(state.byWorkspace, workspacePath)
}

function relativeTo(workspacePath: string, path: string): string {
  const prefix = workspacePath.endsWith('/') ? workspacePath : workspacePath + '/'
  return path.startsWith(prefix) ? path.slice(prefix.length) : path
}

/** A tab for a file just read. */
function openedFile(workspacePath: string, path: string, file: FileContent): OpenFile {
  return {
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
    ...('revision' in file ? { revision: file.revision } : {}),
  }
}

/** Apply a patch to one workspace's slice, creating it if absent. */
export function patchWorkspace(
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
export function patchFile(
  w: WorkspaceFiles,
  path: string,
  fields: Partial<OpenFile>,
): WorkspaceFiles {
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
  listErrors: {},

  ...fileListingActions(set, get),

  openFile: async (workspacePath, path, target) => {
    // A Host key routes IPC to the Host; a path outside it would read this device's disk.
    if (workspacePath.startsWith('host:') && !path.startsWith(`${workspacePath}/`))
      throw new Error(REMOTE_UNAVAILABLE)
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
        return {
          ...w,
          openFiles: [...w.openFiles, { ...openedFile(workspacePath, path, file), ...reveal }],
          activePath: path,
          activeRequest: (w.activeRequest ?? 0) + 1,
        }
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
    sourceTraits.delete(workspacePath)
    set((s) => {
      const byWorkspace = { ...s.byWorkspace }
      delete byWorkspace[workspacePath]
      const listErrors = { ...s.listErrors }
      delete listErrors[workspacePath]
      // Explorer listings and expansion flags are keyed by absolute dir path,
      // so they are pruned by prefix rather than by workspace key.
      const prefix = workspacePath.endsWith('/') ? workspacePath : workspacePath + '/'
      const keep = (key: string): boolean => key !== workspacePath && !key.startsWith(prefix)
      const entries = Object.fromEntries(Object.entries(s.entries).filter(([k]) => keep(k)))
      const expanded = Object.fromEntries(Object.entries(s.expanded).filter(([k]) => keep(k)))
      const directoryMtimes = Object.fromEntries(
        Object.entries(s.directoryMtimes).filter(([k]) => keep(k)),
      )
      return { byWorkspace, listErrors, entries, expanded, directoryMtimes }
    })
    if (paths.length > 0) {
      void import('@/features/files/MonacoEditor').then(({ releaseFileModel }) => {
        for (const path of paths) releaseFileModel(path)
      })
    }
  },

  ...fileTabActions(set, get),
  ...fileSaveActions(set, get),
}))
