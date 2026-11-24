import { setTimeout as wait } from 'node:timers/promises'
import { app, dialog } from 'electron'
import type { LocalRuntimeMode } from '@phosphor/shared/ipc'
import { log } from '../debug-log'
import { bindLocalMachineGate } from '../ipc/local-machine-handlers'
import { routinesFileName } from '../routines'
import {
  consentMigration,
  launchGateStatus,
  onLaunchGateStatus,
  requestMigrationRetry,
  runLaunchGate,
} from './launch-gate'
import { openServiceChannel } from './migration/desktop-ports'
import { migrationPermit } from './migration/journal'
import { createPostCommitSteps } from './migration/post-commit-steps'
import { checkMigrationTripwire } from './migration/tripwire'
import { RESTORE_IN_APP_FLAG, restoreInAppRuntime } from './restore'
import { restoreServicePorts } from './restore-service'

/**
 * Once per process, after IPC registers and before pi's config, a window or
 * any session: the break-glass restore when asked for, then the launch gate,
 * then the old-Desktop tripwire in daemon mode. `quit` when a restore failed.
 */
export async function decideLocalRuntime(): Promise<LocalRuntimeMode | 'quit'> {
  const userData = app.getPath('userData')
  const routinesFile = routinesFileName()
  const permit = migrationPermit({ isPackaged: app.isPackaged, env: process.env })
  if (process.argv.includes(RESTORE_IN_APP_FLAG)) {
    try {
      await restoreInAppRuntime({
        userData,
        routinesFile,
        permit,
        ...restoreServicePorts({
          open: openServiceChannel,
          now: Date.now,
          wait: (ms) => wait(ms),
          log: (event, data) => log('migration', event, data),
        }),
      })
    } catch (error) {
      log('migration', 'restore refused', { error: String(error) })
      dialog.showErrorBox('Could not restore the in-app runtime', String(error))
      app.quit()
      return 'quit'
    }
  }
  bindLocalMachineGate({
    status: launchGateStatus,
    onStatus: onLaunchGateStatus,
    retry: requestMigrationRetry,
    consent: consentMigration,
  })
  const mode = await runLaunchGate({ postCommit: createPostCommitSteps({ routinesFile }) })
  if (mode === 'daemon' && permit.allowed) await tripwire(userData, routinesFile)
  return mode
}

/** Warns once when an older Desktop used migrated data; never falls back to in-app. */
async function tripwire(userData: string, routinesFile: ReturnType<typeof routinesFileName>) {
  try {
    await checkMigrationTripwire({
      userData,
      routinesFile,
      warn: (message) => {
        dialog
          .showMessageBox({ type: 'warning', message: 'Phosphor', detail: message })
          .catch((error: unknown) =>
            log('migration', 'tripwire warning failed', { error: String(error) }),
          )
      },
      log: (event) => log('migration', event),
      // The service reconciles its folders when it starts; nothing re-reads them sooner.
      rescan: async () => log('migration', 'tripwire rescan deferred to the service restart'),
    })
  } catch (error) {
    log('migration', 'tripwire failed', { error: String(error) })
  }
}
