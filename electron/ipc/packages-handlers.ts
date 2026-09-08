import { app } from 'electron'
import { handle } from './handle'
import {
  checkClaudeCliUpdate,
  checkPackageUpdates,
  claudeStatus,
  detectBinaries,
  listPackages,
  runClaudeProviderTest,
  runClaudeUpdate,
  runPackageAction,
  runPiInstall,
} from '../pi/packages'

/**
 * Same e2e hook and gating as pi-session-handlers: an env-var-provided
 * script may only replace pi in unpackaged builds — honoring it in a
 * shipped app would be env-var-triggered code execution.
 */
function piStubPath(): string | undefined {
  if (app.isPackaged) return undefined
  return process.env.PHOSPHOR_PI_STUB || undefined
}

/** E2E-only claude override, so a developer's real install can't shadow it. */
function claudeBinOverride(): string | undefined {
  if (app.isPackaged) return undefined
  return process.env.PHOSPHOR_CLAUDE_BIN || undefined
}

/** pi package listing + mutations via pi's own CLI (streamed jobs). */
export function registerPackagesHandlers(): void {
  handle('packages:list', async (_event, workspacePath?: string) => listPackages(workspacePath))

  handle('packages:run', (event, action, spec, scope, workspacePath) =>
    runPackageAction(event.sender, action, spec, scope, workspacePath, piStubPath()),
  )

  handle('packages:installPi', (event) => runPiInstall(event.sender))

  handle('packages:checkUpdates', async (_event, workspacePath?: string) =>
    checkPackageUpdates(await listPackages(workspacePath)),
  )

  handle('packages:detect', () => detectBinaries(claudeBinOverride()))

  handle('packages:claudeStatus', () => claudeStatus(claudeBinOverride()))

  handle('packages:claudeCliLatest', () => checkClaudeCliUpdate())

  handle('packages:updateClaudeCli', (event) => runClaudeUpdate(event.sender, claudeBinOverride()))

  handle('packages:testClaudeProvider', (event) =>
    runClaudeProviderTest(event.sender, piStubPath()),
  )
}
