import { writeFile } from 'node:fs/promises'
import { BrowserWindow, dialog } from 'electron'
import { handle } from './handle'
import { invalidatePiCommands } from './pi-config-handlers'
import { cachedPiHealth } from '../pi/health'
import { piProcessEnv } from '../pi/shell-env'
import { piStubPath } from '../pi/stub'
import {
  buildSkillZip,
  confirmSkillImport,
  createSkill,
  deleteSkill,
  installCatalogSkill,
  previewSkillImport,
  readSkillFileEntry,
  resolveSkills,
  writeSkillFileEntry,
} from '../pi/skills'

/**
 * Skills page: list/inspect what pi resolves, create and edit bundles in the
 * phosphor-writable roots, install from the pinned catalog, import and export.
 *
 * The list probe follows the same stub contract as every other headless pi
 * spawn (`pi:catalogueModels` learned this the hard way): under e2e the stub
 * script answers RPC through Electron-as-Node, and a probe that ignored it
 * would shell out to the real binary from inside the test sandbox.
 */
export function registerSkillsHandlers(): void {
  handle('skills:list', async (_event, workspacePath) => {
    const stub = piStubPath()
    if (stub) {
      return resolveSkills({
        ...(workspacePath ? { workspacePath } : {}),
        binaryPath: process.execPath,
        prefixArgs: [stub],
        env: { ELECTRON_RUN_AS_NODE: '1' },
      })
    }
    const health = await cachedPiHealth()
    const binaryPath = health.ok ? health.binaryPath : undefined
    return resolveSkills({
      ...(workspacePath ? { workspacePath } : {}),
      ...(binaryPath
        ? {
            binaryPath,
            ...(health.prefixArgs ? { prefixArgs: health.prefixArgs } : {}),
            env: await piProcessEnv(),
          }
        : {}),
    })
  })

  handle('skills:readFile', (_event, dir, relPath) => readSkillFileEntry(dir, relPath))

  // Every mutation below changes which `skill:*` commands pi resolves, so each
  // one drops the cached `/` list once it has landed on disk.
  handle('skills:create', async (_event, options) => {
    const result = await createSkill(options)
    invalidatePiCommands()
    return result
  })

  handle('skills:writeFile', async (_event, dir, relPath, content, workspacePath) => {
    const result = await writeSkillFileEntry(dir, relPath, content, workspacePath)
    invalidatePiCommands()
    return result
  })

  handle('skills:delete', async (_event, dir, workspacePath) => {
    const result = await deleteSkill(dir, workspacePath)
    invalidatePiCommands()
    return result
  })

  handle('skills:export', async (event, dir) => {
    const { fileName, data } = await buildSkillZip(dir)
    const window = BrowserWindow.fromWebContents(event.sender)
    const result = await dialog.showSaveDialog(window!, {
      defaultPath: fileName,
      filters: [{ name: 'Skill bundle', extensions: ['zip', 'skill'] }],
    })
    if (result.canceled || !result.filePath) return null
    await writeFile(result.filePath, data)
    return { savedTo: result.filePath }
  })

  handle('skills:install', async (_event, libraryId, skillName, options) => {
    const result = await installCatalogSkill({ libraryId, skillName, ...(options ?? {}) })
    invalidatePiCommands()
    return result
  })

  handle('skills:importPick', async (event) => {
    const window = BrowserWindow.fromWebContents(event.sender)
    const result = await dialog.showOpenDialog(window!, {
      properties: ['openFile'],
      filters: [{ name: 'Skill', extensions: ['md', 'zip', 'skill'] }],
    })
    const sourcePath = result.filePaths[0]
    if (result.canceled || !sourcePath) return null
    return previewSkillImport(sourcePath)
  })

  handle('skills:importConfirm', async (_event, options) => {
    const result = await confirmSkillImport(options)
    invalidatePiCommands()
    return result
  })
}
