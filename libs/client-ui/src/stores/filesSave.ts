import type { StoreApi } from 'zustand'
import {
  filesSourceTraits,
  patchFile,
  patchWorkspace,
  workspaceFiles,
  type FilesState,
  type OpenFile,
} from './files'

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
  if (!file || !file.dirty || file.saving || file.saveUncertain) return
  const refusal = filesSourceTraits(workspacePath).writeRefusal
  if (refusal) throw new Error(refusal)
  if (file.revision !== undefined) return saveAtRevision(set, workspacePath, file)
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

/**
 * Save over the revision this buffer was read at. A remounted pane sees `saving` and sends nothing
 * more; a changed file is a conflict; any other failure may have landed, so it is never retried.
 */
async function saveAtRevision(set: SetFiles, workspacePath: string, file: OpenFile): Promise<void> {
  // A lane forgotten mid-save has released its files; its reply then changes nothing. Match the
  // buffer by instance alone: a rename or move during the save changes its path.
  const settle = (fields: Partial<OpenFile> | ((f: OpenFile) => Partial<OpenFile>)) =>
    set((s) =>
      !s.byWorkspace[workspacePath]
        ? s
        : patchWorkspace(s, workspacePath, (w) => ({
            ...w,
            openFiles: w.openFiles.map((f) =>
              f.instanceId === file.instanceId
                ? { ...f, ...(typeof fields === 'function' ? fields(f) : fields) }
                : f,
            ),
          })),
    )
  settle({ saving: true })
  try {
    const saved = await window.phosphor.invoke(
      'fs:writeFile',
      file.path,
      file.content,
      file.revision,
    )
    settle((f) => ({
      saving: false,
      savedContent: file.content,
      dirty: f.content !== file.content,
      revision: saved.revision,
      mtimeMs: saved.mtimeMs,
      size: new TextEncoder().encode(file.content).length,
      diskConflict: false,
    }))
  } catch (error) {
    const conflict = error instanceof Error && error.message.includes('changed-on-disk')
    settle(
      conflict ? { saving: false, diskConflict: true } : { saving: false, saveUncertain: true },
    )
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
            ...('revision' in file ? { revision: file.revision } : {}),
            dirty: false,
            diskConflict: false,
            saveUncertain: false,
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
