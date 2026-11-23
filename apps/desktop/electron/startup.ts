import { BrowserWindow, powerMonitor } from 'electron'
import { startRoutines, stopRoutines, wakeRoutines, routineScheduler } from './routines'
import { installRoutineBackground } from './routines/background'
import { startArtifactSync } from './artifacts/artifact-sync'
import { recordAppLaunch } from './feedback/feedback-service'
import { maintenanceScheduler } from './maintenance/runtime'
import { registry } from './registry'
import { ptyManager } from './pty/pty-manager'
import { disposeMcpConnections } from './pi/mcp-inspection'
import { disposePackageJobs } from './pi/packages'
import { cancelAllLogins } from './pi/login-flow'
import { cancelAllClaudeLogins } from './pi/claude-login'
import { unwatchAll } from './pi/session-watcher'
import { unwatchAllWorkspaces } from './fs/workspace-watcher'
import { settleAccount } from './account'
import { startUpdateChecks, stopUpdateChecks } from './updates/updater'
import { disposeBrain } from './brain/runtime'

export interface StartupContext {
  /** Opens a main window; main.ts owns its chrome and navigation policy. */
  createWindow: () => BrowserWindow
}

/**
 * The services Desktop starts once Electron is ready and IPC is registered,
 * in launch order. main.ts calls it from `app.whenReady`.
 */
export function startServices({ createWindow }: StartupContext): void {
  // Before anything can start a session (routines do, at launch): indexes
  // each session's artifacts as its turns end, then catches up with every
  // session file on disk once per launch.
  startArtifactSync()
  // One count per app start, and the only thing gating the feedback nudge —
  // it waits for real use rather than interrupting a fresh install.
  recordAppLaunch()
  createWindow()
  installRoutineBackground(
    () => {
      const window = BrowserWindow.getAllWindows()[0] ?? createWindow()
      window.show()
      window.focus()
    },
    () => routineScheduler().pauseAll(),
  )
  startRoutines()
  powerMonitor.on('resume', wakeRoutines)
  // No-op unless packaged: dev and E2E must never poll GitHub.
  startUpdateChecks()
  // Reclaims dead lanes on a timer. Unref'd, warms up before its first
  // sweep, and deletes nothing unless the user turned that on.
  maintenanceScheduler.start()
}

/**
 * The approved-quit teardown, in order. Resolves once every step has
 * settled and never rejects; main.ts then lets Electron quit.
 */
export function stopServices(): Promise<void> {
  // Clean shutdown: SIGTERM to every pi child, kill all PTYs, close all
  // filesystem watchers so no chokidar handles or debounce timers outlive us.
  stopUpdateChecks()
  // Before killAll: a login flow polls its own pty on a timer, and killing the
  // pty out from under it would leave that timer running against a dead id.
  cancelAllLogins()
  cancelAllClaudeLogins()
  // Stop sign-ins, but drain native probes that may be saving rotated credentials.
  const mcpConnections = disposeMcpConnections()
  // Package jobs own separate trees too; stop admission before teardown.
  const packageJobs = disposePackageJobs()
  ptyManager.killAll()
  // Stop admission and persist interrupted routine outcomes before disposing
  // unrelated sessions. Routine cancellation owns its nested process tree.
  return Promise.allSettled([stopRoutines(), disposeBrain()]).then(async () => {
    await Promise.allSettled([
      registry.disposeAll(),
      settleAccount(),
      unwatchAll(),
      unwatchAllWorkspaces(),
      packageJobs,
      mcpConnections,
    ])
  })
}
