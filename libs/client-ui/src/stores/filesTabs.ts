import type { StoreApi } from 'zustand'
import { patchFile, patchWorkspace, workspaceFiles, type FilesState } from './files'

type SetFiles = StoreApi<FilesState>['setState']
type GetFiles = StoreApi<FilesState>['getState']

const reopeningWorkspaces = new Set<string>()

/** Tab actions of the files store: activate, close, reopen, pin and reorder. */
export function fileTabActions(
  set: SetFiles,
  get: GetFiles,
): Pick<
  FilesState,
  'closeFile' | 'reopenClosed' | 'togglePinned' | 'moveTab' | 'setActive' | 'setView'
> {
  return {
    closeFile: (workspacePath, path) => closeFile(set, workspacePath, path),

    reopenClosed: async (workspacePath) => {
      if (reopeningWorkspaces.has(workspacePath)) return
      const workspace = workspaceFiles(get(), workspacePath)
      const path = workspace.closedPaths?.find(
        (p) => !workspace.openFiles.some((f) => f.path === p),
      )
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
  }
}

function closeFile(set: SetFiles, workspacePath: string, path: string): void {
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
}
