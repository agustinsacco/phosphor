import { execFile } from 'node:child_process'
import { lstatSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import type { HostReleaseArtifactV2, HostReleaseManifestV2 } from '@phosphor/shared/host-release'
import { isUuid } from '@phosphor/shared/control-api'
import { errorText } from '@phosphor/shared/errors'
import { errnoIs } from '@phosphor/session-runtime/fs-safety'
import { stageRelease } from '@phosphor/session-runtime/host-install/fetch'
import { ensureLauncher } from '@phosphor/session-runtime/host-install/launcher'
import { INSTALL_COMMAND } from '@phosphor/session-runtime/host-install/layout'
import { acquireInstallLock } from '@phosphor/session-runtime/host-install/lock'
import { probeStagedBundle } from '@phosphor/session-runtime/host-install/probe'
import {
  LOCAL_SERVICE_FEATURES,
  requireLocalRelease,
} from '@phosphor/session-runtime/host-install/release-source'
import { inspectExisting, type InspectPorts } from './adopt'
import {
  checkRelease,
  createManifestWatch,
  type ManifestWatchPorts,
  type ReleaseWait,
} from './manifest-watch'
import type { OwnerKey, OwnerKeyResult } from './owner-key'
import type { DaemonRoots, DaemonRootsResult } from './roots'

/**
 * One attempt to install and pair this machine's Phosphor service (D2 §3.10).
 * It installs a verified release when none exists, then runs
 * `setup --local --standby`: the service holds no owner lock and runs no lanes
 * until migration (M3) commits, so Desktop's in-app runtime keeps running
 * beside it. Nothing here switches Desktop to the service.
 */

export type DaemonBlock =
  | 'owner-key'
  | 'no-pi'
  | 'daemon-owns-lanes'
  | 'source-install'
  | 'unrecognised-install'
  | 'needs-update'

export type DaemonInstallStatus =
  | { state: 'off'; detail: string }
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'waiting'; reason: ReleaseWait; detail: string }
  | { state: 'blocked'; reason: DaemonBlock; detail: string; pid?: number; installed?: string }
  | { state: 'installing'; step: 'download' | 'setup'; version?: string }
  | { state: 'failed'; detail: string }
  | {
      state: 'installed'
      version: string
      /** Desktop calls the service by this absolute path, never through PATH. */
      program: string
      machineId: string
      launcher: 'created' | 'ours' | 'foreign' | 'unsafe'
    }

export type ProgramRunner = (
  program: string,
  args: readonly string[],
  options: { env: Record<string, string>; timeoutMs: number; signal: AbortSignal },
) => Promise<{ code: number | null; stdout: string }>

export interface DaemonInstallPorts {
  roots: DaemonRoots
  ownerKey(): Promise<OwnerKeyResult>
  /** pi's absolute path from the login shell, or null. */
  findPi(): Promise<string | null>
  /** The login shell's PATH, so `setup` finds pi, claude and git (V7). */
  shellPath(): Promise<string | null>
  /** USER, LOGNAME, LANG, TMPDIR and the like; never Electron's own variables. */
  baseEnv?: Record<string, string>
  run?: ProgramRunner
  inspect?: InspectPorts
  uid?: number
}

export const SETUP_TIMEOUT_MS = 120_000
const OUTPUT_CAP = 64 * 1024

const defaultRun: ProgramRunner = (program, args, { env, timeoutMs, signal }) =>
  new Promise((resolve) => {
    execFile(
      program,
      args,
      { env, timeout: timeoutMs, maxBuffer: OUTPUT_CAP, signal, killSignal: 'SIGKILL' },
      (error, stdout) => {
        const code = error ? (typeof error.code === 'number' ? error.code : null) : 0
        resolve({ code, stdout: String(stdout) })
      },
    )
  })

const blocked = (reason: DaemonBlock, detail: string, extra = {}): DaemonInstallStatus => ({
  state: 'blocked',
  reason,
  detail,
  ...extra,
})

/** Create the install folders like install.sh does; refuse links and folders another user owns. */
function prepareLib(roots: DaemonRoots, uid: number | undefined): void {
  const local = join(roots.home, '.local')
  for (const dir of [local, join(local, 'lib'), roots.lib, join(roots.lib, 'versions')]) {
    try {
      mkdirSync(dir, { mode: 0o755 })
    } catch (error) {
      if (!errnoIs(error, 'EEXIST')) throw error
    }
    const info = lstatSync(dir)
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== uid)
      throw new Error(`Unsafe install folder: ${dir}.`)
  }
}

const exists = (path: string) => {
  try {
    lstatSync(path)
    return true
  } catch (error) {
    if (errnoIs(error, 'ENOENT')) return false
    throw error
  }
}

/** Download, verify, probe and publish a first release; `current` appears last. */
async function installRelease(
  ports: DaemonInstallPorts,
  release: HostReleaseManifestV2,
  artifact: HostReleaseArtifactV2,
  signal: AbortSignal,
): Promise<void> {
  const { roots } = ports
  prepareLib(roots, ports.uid ?? process.getuid?.())
  const unlock = acquireInstallLock(roots.lib)
  let stage: string | undefined
  try {
    const destination = join(roots.lib, 'versions', release.version)
    if (exists(join(roots.lib, 'current'))) throw new Error('The service install changed; retry.')
    if (exists(destination)) throw new Error(`Existing version: ${destination}.`)
    stage = mkdtempSync(join(roots.lib, '.staging-'))
    const source = { ...roots.release, platform: roots.platform }
    await stageRelease(source, stage, release.version, artifact, signal)
    requireLocalRelease(release, await probeStagedBundle(stage, signal), roots.target)
    signal.throwIfAborted()
    renameSync(stage, destination)
    stage = undefined
    const link = join(roots.lib, `.current-${process.pid}`)
    rmSync(link, { force: true })
    symlinkSync(`versions/${release.version}`, link)
    renameSync(link, join(roots.lib, 'current'))
  } finally {
    if (stage) rmSync(stage, { recursive: true, force: true })
    unlock()
  }
}

interface SetupReport {
  exitCode?: unknown
  notes?: unknown
  machineId?: unknown
}

function setupReport(stdout: string): SetupReport {
  try {
    const value: unknown = JSON.parse(stdout.trim().split('\n').pop() ?? '')
    return value && typeof value === 'object' ? (value as SetupReport) : {}
  } catch {
    return {}
  }
}

async function runSetup(
  ports: DaemonInstallPorts,
  key: OwnerKey,
  pi: string,
  version: string,
  signal: AbortSignal,
): Promise<DaemonInstallStatus> {
  const { roots } = ports
  const program = join(roots.lib, 'current/bin/phosphor')
  const env = {
    ...ports.baseEnv,
    HOME: roots.home,
    PATH: (await ports.shellPath()) ?? '/usr/bin:/bin:/usr/sbin:/sbin',
    ...roots.xdg,
  }
  const args = ['setup', '--local', '--json', '--standby', '--pi', pi]
  args.push('--owner-id', key.id, '--owner-key', key.publicKey, '--owner-label', key.label)
  const run = ports.run ?? defaultRun
  const { code, stdout } = await run(program, args, { env, timeoutMs: SETUP_TIMEOUT_MS, signal })
  const report = setupReport(stdout)
  const notes = Array.isArray(report.notes) ? report.notes.filter((n) => typeof n === 'string') : []
  if (code !== 0 || report.exitCode !== 0 || !isUuid(report.machineId))
    return { state: 'failed', detail: notes.join(' ') || `Service setup exited with ${code}.` }
  let launcher: 'created' | 'ours' | 'foreign' | 'unsafe'
  try {
    launcher = ensureLauncher(roots.home, ports.uid ?? process.getuid?.())
  } catch {
    launcher = 'unsafe'
  }
  return { state: 'installed', version, program, machineId: report.machineId, launcher }
}

const hasLocalFeatures = (features: readonly string[]) =>
  LOCAL_SERVICE_FEATURES.every((name) => features.includes(name))

/** One full attempt. `report` sees each step; the result is the attempt's final status. */
export async function attemptDaemonInstall(
  ports: DaemonInstallPorts,
  signal: AbortSignal,
  report: (status: DaemonInstallStatus) => void = () => {},
): Promise<DaemonInstallStatus> {
  const { roots } = ports
  const machine = roots.platform === 'darwin' ? 'this Mac' : 'this computer'
  try {
    report({ state: 'checking' })
    const readiness = await checkRelease(roots.release, roots.target, signal)
    if (!readiness.ready)
      return { state: 'waiting', reason: readiness.reason, detail: readiness.detail }
    const { release, artifact } = readiness
    const key = await ports.ownerKey()
    if (!key.ok) return blocked('owner-key', key.reason)
    const pi = await ports.findPi()
    if (!pi) return blocked('no-pi', 'Install pi to set up the Phosphor service.')
    const existing = await inspectExisting(roots, signal, ports.inspect)
    if (existing.kind === 'daemon')
      return blocked(
        'daemon-owns-lanes',
        `Another Phosphor daemon owns ${machine}'s lanes (pid ${existing.pid}).`,
        { pid: existing.pid },
      )
    if (existing.kind === 'source')
      return blocked(
        'source-install',
        `Install a release with ${INSTALL_COMMAND}, or remove the source service at ${existing.file}.`,
      )
    if (existing.kind === 'unrecognised') return blocked('unrecognised-install', existing.detail)
    let version = release.version
    if (existing.kind === 'release') {
      if (!hasLocalFeatures(existing.features))
        return blocked(
          'needs-update',
          `Phosphor service ${existing.version} must update to ${release.version} first.`,
          { installed: existing.version },
        )
      version = existing.version
    } else {
      report({ state: 'installing', step: 'download', version })
      await installRelease(ports, release, artifact, signal)
    }
    report({ state: 'installing', step: 'setup', version })
    return await runSetup(ports, key.key, pi, version, signal)
  } catch (error) {
    return { state: 'failed', detail: errorText(error) }
  }
}

/** Outcomes that end the retries: installed, or waiting on a decision M3 or M6 owns. */
export function installSettled(status: DaemonInstallStatus): boolean {
  return (
    status.state === 'installed' ||
    (status.state === 'blocked' &&
      (status.reason === 'daemon-owns-lanes' || status.reason === 'needs-update'))
  )
}

/** The service install as M3 starts it and M6 shows it. */
export interface DaemonInstall {
  status(): DaemonInstallStatus
  subscribe(listener: (status: DaemonInstallStatus) => void): () => void
  start(): void
  /** Forward window focus: checks again once 30 minutes have passed. */
  focus(): void
  stop(): void
}

export type DaemonInstallDeps = Omit<DaemonInstallPorts, 'roots'> & {
  watch?: Omit<ManifestWatchPorts, 'attempt'>
}

export function createDaemonInstall(
  roots: DaemonRootsResult,
  deps: DaemonInstallDeps,
): DaemonInstall {
  let current: DaemonInstallStatus = roots.on
    ? { state: 'idle' }
    : { state: 'off', detail: roots.reason }
  const listeners = new Set<(status: DaemonInstallStatus) => void>()
  const publish = (status: DaemonInstallStatus) => {
    current = status
    for (const listener of listeners) listener(status)
  }
  const ports = roots.on ? { ...deps, roots: roots.roots } : null
  const watch = ports
    ? createManifestWatch({
        ...deps.watch,
        attempt: async (signal) => {
          const status = await attemptDaemonInstall(ports, signal, publish)
          if (!signal.aborted) publish(status)
          return installSettled(status) ? 'done' : 'retry'
        },
      })
    : null
  return {
    status: () => current,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    start: () => watch?.start(),
    focus: () => watch?.focus(),
    stop: () => watch?.stop(),
  }
}
