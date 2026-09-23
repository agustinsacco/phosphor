import { BrowserWindow, dialog, shell } from 'electron'
import { grantPreview } from '../fs/file-protocol'
import { transferEntry } from '../fs/file-transfer'
import { openInDefaultApp } from '../fs/open-file'
import { handle } from './handle'
import { listWorkspaceFiles } from '../fs/list-files'
import { watchWorkspace } from '../fs/workspace-watcher'
import {
  createDir,
  createFile,
  listDir,
  readTextFile,
  renamePath,
  statDirectories,
  writeTextFile,
} from '../fs/fs-service'

/** Workspace file listing, reads/writes, and change watching. */
export function registerFsHandlers(): void {
  handle('fs:listFiles', (_event, workspacePath: string) => listWorkspaceFiles(workspacePath))

  handle('fs:readDir', (_event, workspacePath, dirPath, options) =>
    listDir(workspacePath, dirPath, options),
  )

  handle('fs:readFile', (_event, path) => readTextFile(path))

  handle('fs:previewUrl', (_event, workspacePath, path) => grantPreview(workspacePath, path))

  handle('fs:openInDefaultApp', (_event, path) => openInDefaultApp(path))

  // Quick Look renders from the OS's own previewers and never runs the file,
  // so unlike `fs:openInDefaultApp` it needs no launch guard.
  handle('fs:quickLook', (event, path) => {
    if (process.platform !== 'darwin') return
    BrowserWindow.fromWebContents(event.sender)?.previewFile(path)
  })

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

  handle('fs:statDirs', (_event, paths) => statDirectories(paths))
}
