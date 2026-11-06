import type { StoreApi } from 'zustand'
import { patchFile, patchWorkspace, workspaceFiles, type FilesState } from './files'

type SetFiles = StoreApi<FilesState>['setState']
type GetFiles = StoreApi<FilesState>['getState']

const fileWrites = new Map<string, Promise<void>>()

/** Editing, saving and disk-conflict actions of the files store. */
export function fileSaveActions(
  set: SetFiles,
  get: GetFiles,
): Pick<
  FilesState,
  'updateBuffer' | 'saveFile' | 'handleExternalChanges' | 'reloadFromDisk' | 'keepBuffer'
> {
  return {
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
    saveFile: (workspacePath, path) => saveFile(set, get, workspacePath, path),
    handleExternalChanges: async (workspacePath, paths) => {
      const changed = new Set(paths)
      const affected = workspaceFiles(get(), workspacePath).openFiles.filter((f) =>
        changed.has(f.path),
      )
      for (const file of affected) {
        if (file.dirty) {
          set((s) =>
            patchWorkspace(s, workspacePath, (w) =>
              patchFile(w, file.path, { diskConflict: true }),
            ),
          )
        } else {
          await get().reloadFromDisk(workspacePath, file.path)
        }
      }
    },
    reloadFromDisk: (workspacePath, path) => reloadFromDisk(set, get, workspacePath, path),
    keepBuffer: (workspacePath, path) => {
      set((s) =>
        patchWorkspace(s, workspacePath, (w) =>
          patchFile(w, path, { diskConflict: false, dirty: true }),
        ),
      )
    },
  }
}

async function saveFile(
  set: SetFiles,
  get: GetFiles,
  workspacePath: string,
  path: string,
): Promise<void> {
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
}

async function reloadFromDisk(
  set: SetFiles,
  get: GetFiles,
  workspacePath: string,
  path: string,
): Promise<void> {
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
}
