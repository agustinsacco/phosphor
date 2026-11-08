import { BrowserWindow, dialog } from 'electron'
import { handle } from './handle'
import { readSkillFileEntry } from '../pi/skills'
import {
  confirmSkillImportAction,
  createSkillAction,
  deleteSkillAction,
  exportSkill,
  installSkillAction,
  listSkills,
  pickSkillImport,
  restoreBundledSkill,
  saveSkillBundle,
  writeSkillFileAction,
} from '../pi/skill-actions'

/** The save dialog both skill archives ask, for the window that asked. */
function askArchivePath(sender: Electron.WebContents) {
  return async (fileName: string): Promise<string | null> => {
    const window = BrowserWindow.fromWebContents(sender)
    const result = await dialog.showSaveDialog(window!, {
      defaultPath: fileName,
      filters: [{ name: 'Skill bundle', extensions: ['zip', 'skill'] }],
    })
    return result.canceled || !result.filePath ? null : result.filePath
  }
}

/** Skills IPC keeps Electron dialogs here; actions own discovery and invalidation. */
export function registerSkillsHandlers(): void {
  handle('skills:list', (_event, workspacePath) => listSkills(workspacePath))
  handle('skills:restoreBundled', () => restoreBundledSkill())
  handle('skills:readFile', (_event, dir, relPath) => readSkillFileEntry(dir, relPath))
  handle('skills:create', (_event, options) => createSkillAction(options))
  handle('skills:writeFile', (_event, dir, relPath, content, workspacePath) =>
    writeSkillFileAction(dir, relPath, content, workspacePath),
  )
  handle('skills:delete', (_event, dir, workspacePath) => deleteSkillAction(dir, workspacePath))
  handle('skills:export', (event, dir) => exportSkill(dir, askArchivePath(event.sender)))
  handle('skills:saveBundle', (event, bundle) =>
    saveSkillBundle(bundle, askArchivePath(event.sender)),
  )
  handle('skills:install', (_event, libraryId, skillName, options) =>
    installSkillAction(libraryId, skillName, options),
  )
  handle('skills:importPick', (event) =>
    pickSkillImport(async () => {
      const window = BrowserWindow.fromWebContents(event.sender)
      const result = await dialog.showOpenDialog(window!, {
        properties: ['openFile'],
        filters: [{ name: 'Skill', extensions: ['md', 'zip', 'skill'] }],
      })
      return result.canceled || !result.filePaths[0] ? null : result.filePaths[0]
    }),
  )
  handle('skills:importConfirm', (_event, options) => confirmSkillImportAction(options))
}
