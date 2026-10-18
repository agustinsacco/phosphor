import { handle } from './handle'
import { invalidateCatalogueModels, invalidatePiCommands } from './pi-config-handlers'
import {
  checkClaudeCliUpdate,
  checkPackageUpdates,
  claudeStatus,
  detectBinaries,
  runClaudeProviderTest,
  runClaudeUpdate,
  runPackageAction,
  runPiInstall,
} from '../pi/packages'
import { listPackages } from '@phosphor/session-runtime/pi/packages'

import { claudeBinOverride, piStubPath } from '../pi/stub'

/** pi package listing + mutations via pi's own CLI (streamed jobs). */
export function registerPackagesHandlers(): void {
  handle('packages:list', async (_event, workspacePath?: string) => listPackages(workspacePath))

  // A package can bring a provider (models) as well as extensions, skills and
  // prompts (commands), so both caches are stale once the job ends — whatever
  // its exit code: a failed install can still have changed settings.json.
  // Neither was invalidated before; installing a provider left the model
  // picker wrong for the catalogue's full five-minute TTL.
  handle('packages:run', (event, action, spec, scope, workspacePath) =>
    runPackageAction(event.sender, action, spec, scope, workspacePath, piStubPath(), () => {
      invalidateCatalogueModels()
      invalidatePiCommands()
    }),
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
