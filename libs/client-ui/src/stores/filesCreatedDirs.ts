import type { StoreApi } from 'zustand'
import { filesSourceTraits, patchWorkspace, type FilesState } from './files'

/**
 * A flat listing (a Host's) lists files only, so a folder this client made shows from the files
 * store until the list shows it by holding a file. A tree listing reads folders itself.
 */
export function createdDirActions(
  set: StoreApi<FilesState>['setState'],
): Pick<FilesState, 'addCreatedDir'> {
  return {
    addCreatedDir: (workspacePath, dirPath) => {
      if (filesSourceTraits(workspacePath).listing !== 'flat') return
      set((s) =>
        patchWorkspace(s, workspacePath, (w) => ({
          ...w,
          createdDirs: [...(w.createdDirs ?? []).filter((dir) => dir !== dirPath), dirPath],
        })),
      )
    },
  }
}

/** The made folders `files` does not show: a folder holding a file is listed, so it is dropped. */
export function unlistedDirs(workspacePath: string, made: string[], files: string[]): string[] {
  const listed = files.map((file) => `${workspacePath}/${file}`)
  return made.filter((dir) => !listed.some((path) => path.startsWith(`${dir}/`)))
}
