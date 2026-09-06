import { dialog, shell } from 'electron'
import { transferEntry } from '../fs/file-transfer'
import { handle } from './handle'
import { listWorkspaceFiles } from '../fs/list-files'
import { watchWorkspace } from '../fs/workspace-watcher'
import {
  createDir,
  createFile,
  listDir,
  readTextFile,
  renamePath,
  writeTextFile,
} from '../fs/fs-service'

/** Workspace file listing, reads/writes, and change watching. */
export function registerFsHandlers(): void {
  handle('fs:listFiles', (_event, workspacePath: string) => listWorkspaceFiles(workspacePath))

  handle('fs:readDir', (_event, workspacePath, dirPath, options) =>
    listDir(workspacePath, dirPath, options),
  )

  handle('fs:readFile', (_event, path) => readTextFile(path))

  handle('fs:writeFile', (_event, path, content) => writeTextFile(path, content))

  handle('fs:createFile', (_event, path) => createFile(path))

  handle('fs:createDir', (_event, path) => createDir(path))

  handle('fs:rename', (_event, from, to) => renamePath(from, to))

  handle('fs:trash', async (_event, path) => {
    await shell.trashItem(path)
  })

  handle('fs:transfer', (_event, workspace, source, directory, mode) =>
    transferEntry(workspace, source, directory, mode),
  )

  handle('fs:pickEntries', async (_event, kind) => {
    const result = await dialog.showOpenDialog({
      title: kind === 'folder' ? 'Import folders' : 'Import files',
      properties: [kind === 'folder' ? 'openDirectory' : 'openFile', 'multiSelections'],
    })
    return result.canceled ? [] : result.filePaths
  })

  handle('fs:watchWorkspace', (_event, workspacePath) => {
    watchWorkspace(workspacePath)
  })
}
