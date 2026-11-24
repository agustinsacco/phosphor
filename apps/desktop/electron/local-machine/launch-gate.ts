import { homedir } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'
import type { LocalMachineStatus, LocalRuntimeMode } from '@phosphor/shared/ipc'
import { getLoginShellPath } from '@phosphor/session-runtime/pi/shell-env'
import { cipher } from '../account'
import { log } from '../debug-log'
import { createDaemonInstall, type DaemonInstall } from '../daemon/install'
import { loadOwnerKey } from '../daemon/owner-key'
import { daemonRoots } from '../daemon/roots'
import { resolveBinary } from '../pi/binary-lookup'
import { desktopGatePorts } from './migration/desktop-ports'
import { createLaunchGate, type LaunchGate } from './migration/gate'
import type { ActionResult } from './migration/gate-actions'
import { migrationPermit } from './migration/journal'
import type { PostCommitSteps } from './migration/post-commit'
import { writeServiceRecord } from './migration/service-record'

/**
 * This Mac's launch gate in Desktop main (D1 §3.6-3.7): called once after
 * IPC registers and before any service, window or session starts. It decides
 * in-app or daemon mode once per process, migrating or rolling a migration
 * forward first when the journal and the service say so. While in-app it
 * keeps M1's installer looking for the Phosphor service and records the one
 * it installs, so a later launch can move This Mac onto it.
 */

const BEFORE_GATE: LocalMachineStatus = { mode: 'in-app', migration: 'not-needed' }

let gate: LaunchGate | null = null
let install: DaemonInstall | null = null
const listeners = new Set<(status: LocalMachineStatus) => void>()

export interface LaunchGateOptions {
  /** M4's steps 15 and 16 (`createPostCommitSteps`); a missing step stays pending. */
  readonly postCommit?: PostCommitSteps
}

/** Decides This Mac's runtime mode; resolves once it is decided. Never rejects. */
export async function runLaunchGate(options: LaunchGateOptions = {}): Promise<LocalRuntimeMode> {
  gate ??= createLaunchGate(desktopGatePorts(options.postCommit ?? {}))
  gate.onStatus((status) => {
    for (const listener of [...listeners]) listener(status)
  })
  let mode: LocalRuntimeMode
  try {
    mode = await gate.run()
  } catch (error) {
    log('migration', 'launch gate failed', { error: String(error) })
    mode = 'in-app'
  }
  log('migration', 'mode decided', { mode, migration: gate.status().migration })
  if (mode === 'in-app') startServiceInstall()
  return mode
}

export function launchGateStatus(): LocalMachineStatus {
  return gate?.status() ?? BEFORE_GATE
}

export function onLaunchGateStatus(listener: (status: LocalMachineStatus) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

const NOT_READY: ActionResult = { ok: false, message: 'Phosphor is still starting.' }

export function requestMigrationRetry(): Promise<ActionResult> {
  return gate ? gate.retry() : Promise.resolve(NOT_READY)
}

export function consentMigration(): Promise<ActionResult> {
  return gate ? gate.consent() : Promise.resolve(NOT_READY)
}

/** Before quit teardown: aborts a migration before its commit point, or waits a bounded time after it. */
export function quitLaunchGate(): Promise<void> {
  install?.stop()
  return gate?.quit() ?? Promise.resolve()
}

/** M1's installer, while in-app: a service it installs is recorded for the next launch's gate. */
function startServiceInstall(): void {
  const userData = app.getPath('userData')
  const roots = daemonRoots({
    isPackaged: app.isPackaged,
    env: process.env,
    home: homedir(),
    platform: process.platform,
    arch: process.arch,
  })
  const baseEnv: Record<string, string> = {}
  for (const name of ['USER', 'LOGNAME', 'LANG', 'TMPDIR']) {
    const value = process.env[name]
    if (value) baseEnv[name] = value
  }
  install = createDaemonInstall(roots, {
    ownerKey: () => loadOwnerKey({ dir: join(userData, 'daemon'), cipher: cipher() }),
    findPi: () => resolveBinary('pi'),
    shellPath: getLoginShellPath,
    baseEnv,
  })
  const permitted = migrationPermit({ isPackaged: app.isPackaged, env: process.env }).allowed
  install.subscribe((status) => {
    if (status.state !== 'installed' || !permitted) return
    writeServiceRecord(userData, status, new Date().toISOString())
    gate?.serviceInstalled()
  })
  install.start()
  app.on('browser-window-focus', () => install?.focus())
}
