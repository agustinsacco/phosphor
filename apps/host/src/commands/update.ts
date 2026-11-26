import type { listPackages } from '@phosphor/session-runtime/pi/packages'
import type { SetupTerminal, TerminalScreen } from './setup-terminal'
import { lstatSync, mkdtempSync, realpathSync, renameSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { setTimeout } from 'node:timers/promises'
import { HOST_RELEASE_VERSION_PATTERN, type HostReleaseKey } from '@phosphor/shared/host-release'
import {
  commandLayout,
  INSTALL_COMMAND,
  type InstalledLayout,
} from '@phosphor/session-runtime/host-install/layout'
import {
  fetchSignedRelease,
  stageRelease,
  UpdateFailure,
  type UpdateStep,
} from '@phosphor/session-runtime/host-install/fetch'
import { acquireInstallLock, hasCode } from '@phosphor/session-runtime/host-install/lock'
import { readBounded } from '@phosphor/session-runtime/host-install/files'
import { probeStagedBundle } from '@phosphor/session-runtime/host-install/probe'
import {
  healthBaseline,
  restartedHealthy,
  writeUpdateResult,
  type HealthBaseline,
  type UpdateResult,
} from '../update/health'
import { installLifetime, signalTurn } from '../update/lifetime'
import { stagedLine, UP_TO_DATE } from '../update/staged'
import { HOST_AGENT, HOST_UNIT, hostStateDirectory } from '@phosphor/shared/host-local'
import { serviceRunner } from '../machine/systemd'
import { runService, type ServiceContext } from './service'
import { installedVersion, prune, selectVersion } from './update-select'
import { updateClaudeProvider } from './update-claude'

export {
  compareVersions,
  UpdateFailure,
  type UpdateStep,
} from '@phosphor/session-runtime/host-install/fetch'

export interface UpdateContext extends ServiceContext {
  json?: boolean
  /** Each step as it starts, for a terminal; plain output prints only the result. */
  progress?: (step: UpdateStep) => void
  packages?: typeof listPackages
  setupTerminal?: SetupTerminal
  /** A terminal's screen, which shows the provider update as a log. */
  screen?: TerminalScreen
  update?: {
    node?: string
    bundle?: string
    keys?: readonly HostReleaseKey[]
    expandedCap?: number
    /** This process's /proc/self/cgroup, for the Host-terminal handoff. */
    cgroup?: () => string
    /** The macOS one-shot job's label; tests pass a spike label. */
    jobLabel?: string
    /** Runs a staged bundle's `version --json`. */
    probe?: typeof probeStagedBundle
  }
}
export interface UpdateOptions {
  version?: string
  check?: boolean
  rollback?: boolean
  /** Verify, download, probe and publish to `versions/<v>`, selecting nothing. */
  stage?: boolean
  /** Select a staged release and restart the service. */
  apply?: string
}
export async function serviceState(
  context: ServiceContext,
): Promise<{ installed: boolean; running: boolean }> {
  const runner =
    context.service?.runner ?? serviceRunner(context.env, context.print, context.signal)
  if (context.platform === 'darwin') {
    const status = await runner('launchctl', ['print', `gui/${context.uid}/${HOST_AGENT}`])
    const loaded = status.code === 0
    const running =
      loaded &&
      status.stdout.length <= 65536 &&
      /^[\t ]*(?:state = running|pid = [1-9][0-9]{0,9})[\t ]*\r?$/m.test(status.stdout)
    return {
      installed:
        loaded || exists(join(context.home, 'Library/LaunchAgents', `${HOST_AGENT}.plist`)),
      running,
    }
  }
  if (context.platform !== 'linux') return { installed: false, running: false }
  const running = await runner('systemctl', ['--user', 'is-active', '--quiet', HOST_UNIT])
    .then((result) => result.code === 0)
    .catch(() => false)
  return {
    installed:
      running ||
      exists(
        join(
          context.env.XDG_CONFIG_HOME ?? join(context.home, '.config'),
          'systemd/user',
          HOST_UNIT,
        ),
      ),
    running,
  }
}
function exists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return false
    throw error
  }
}
const HEALTH_WAIT_SECONDS = 180

/** Restarts the service and waits for the new version to be healthy (`restartedHealthy`). */
async function restartHealthy(
  context: UpdateContext,
  version: string,
  baseline: HealthBaseline,
  signal: AbortSignal,
): Promise<boolean> {
  const now = context.now ?? Date.now
  context.progress?.({ step: 'restart', version })
  const restarted = (await runService({ ...context, signal }, 'restart')) === 0
  // A signal that also ended systemctl says nothing about health; rollback would race the restart.
  signal.throwIfAborted()
  if (!restarted) return false
  context.progress?.({ step: 'health', version })
  const wait = context.wait ?? ((ms, signal) => setTimeout(ms, undefined, { signal }))
  const state = hostStateDirectory(context.env, context.home)
  for (let i = 0; i <= HEALTH_WAIT_SECONDS; i++) {
    signal.throwIfAborted()
    if (restartedHealthy(baseline, version, state, context.uid, now())) return true
    if (i < HEALTH_WAIT_SECONDS) await wait(1000, signal)
  }
  return false
}
/** Printed by a plain update of a local daemon: it restarts without pausing lanes first. */
export const LANES_STOP_NOTICE =
  'Lanes that are working will be stopped and saved. Update from Phosphor to pause them first.'

/** What one run holds, so `finally` can undo whatever it left half-done. */
interface UpdateWork {
  stage?: string
  release?: () => void
  published?: string
  selected: boolean
}

function invalidOptions({ version, check, rollback, stage, apply }: UpdateOptions): boolean {
  const pattern = (v: string | undefined) => v === undefined || HOST_RELEASE_VERSION_PATTERN.test(v)
  if (!pattern(version) || !pattern(apply)) return true
  if (rollback && (version !== undefined || check)) return true
  const modes = [stage, apply !== undefined, rollback, check].filter(Boolean).length
  return (stage || apply !== undefined) && (modes > 1 || version !== undefined)
}

/** The install lock, then the layout again: an install that changed under it is refused. */
function lockLayout(context: UpdateContext, work: UpdateWork, signal: AbortSignal) {
  const layout = commandLayout(context.home, context.update?.node, context.update?.bundle)
  if (!layout)
    throw new UpdateFailure(
      `this Host was installed from source; install a release with: ${INSTALL_COMMAND}`,
      69,
    )
  work.release = acquireInstallLock(layout.lib)
  signal.throwIfAborted()
  if (
    commandLayout(context.home, context.update?.node, context.update?.bundle)?.version !==
    layout.version
  )
    throw new UpdateFailure('Install changed; retry update.')
  return layout
}

/** Releases the install lock, then lets a signal queued meanwhile end the run. */
async function unlock(work: UpdateWork, signal: AbortSignal): Promise<void> {
  work.release?.()
  work.release = undefined
  await signalTurn()
  signal.throwIfAborted()
}

function previousVersion(layout: InstalledLayout): string {
  const record: unknown = JSON.parse(readBounded(join(layout.lib, 'install.json'), 1024))
  if (
    !record ||
    typeof record !== 'object' ||
    !('current' in record) ||
    record.current !== layout.version ||
    !('previous' in record) ||
    !installedVersion(layout, record.previous) ||
    record.previous === layout.version
  )
    throw new UpdateFailure('No valid previous version is installed.', 69)
  return record.previous
}

/** Moves the verified staging folder to `versions/<v>`. Synchronous, so no signal lands inside. */
function publish(layout: InstalledLayout, version: string, work: UpdateWork): void {
  if (!work.stage) return
  const destination = join(layout.lib, 'versions', version)
  // Newer than current, so only a rolled-back update or an earlier stage left it: the verified bundle wins.
  rmSync(destination, { recursive: true, force: true })
  renameSync(work.stage, destination)
  work.published = destination
  work.stage = undefined
}

/**
 * The signed release to select, staged under the install; or the exit code
 * that ends the run (`--check`, or already current). `--stage` stops after
 * probing and publishing it, without selecting.
 */
async function fetchRelease(
  context: UpdateContext,
  options: UpdateOptions,
  layout: InstalledLayout,
  work: UpdateWork,
  signal: AbortSignal,
): Promise<{ version: string; notice?: string } | number> {
  const source = { ...context, ...context.update }
  const found = await fetchSignedRelease(source, options.version, layout.version, signal)
  if (options.check || found.version === layout.version) {
    await unlock(work, signal)
    if (options.check) {
      context.print(`Installed: ${layout.version}; available: ${found.version}`)
      if (found.notice) context.print(found.notice)
      return 0
    }
    if (!options.stage) await updateClaudeProvider(context, signal)
    context.print(UP_TO_DATE)
    return 0
  }
  work.stage = mkdtempSync(join(layout.lib, '.staging-'))
  await stageRelease(source, work.stage, found.version, found.artifact, signal)
  if (!options.stage) return { version: found.version, notice: found.notice }
  const probed = await (context.update?.probe ?? probeStagedBundle)(work.stage, signal)
  if (probed.hostVersion !== found.version)
    throw new UpdateFailure('The staged release reports another version.')
  publish(layout, found.version, work)
  work.published = undefined
  await unlock(work, signal)
  context.print(stagedLine(found.version))
  if (found.notice) context.print(found.notice)
  return 0
}

/** Selects the release, restarts a running service and rolls back when it is not healthy. */
async function selectAndRestart(
  context: UpdateContext,
  options: UpdateOptions,
  layout: InstalledLayout,
  target: { version: string; notice?: string },
  work: UpdateWork,
  signal: AbortSignal,
): Promise<number> {
  const { version, notice } = target
  const service = await serviceState(context)
  signal.throwIfAborted()
  const state = hostStateDirectory(context.env, context.home)
  const config = dirname(resolve(context.configPath))
  const baseline = healthBaseline(state, config, context.uid, (context.now ?? Date.now)())
  // All publication calls are synchronous. Signals abort only at the next boundary.
  publish(layout, version, work)
  selectVersion(layout, version, layout.version)
  work.selected = true
  signal.throwIfAborted()
  const record = (outcome: UpdateResult['outcome']) => {
    const at = new Date((context.now ?? Date.now)()).toISOString()
    if (!options.rollback)
      writeUpdateResult(state, context.uid, { from: layout.version, to: version, outcome, at })
  }
  if (service.installed && (service.running || options.rollback)) {
    if (baseline.local && !options.rollback && options.apply === undefined)
      context.print(LANES_STOP_NOTICE)
    if (!(await restartHealthy(context, version, baseline, signal))) {
      context.progress?.({ step: 'rollback', version: layout.version })
      selectVersion(layout, layout.version, version)
      await runService({ ...context, signal }, 'restart')
      record('rolled-back')
      throw new UpdateFailure(
        `update to ${version} failed its health check; rolled back to ${layout.version}`,
      )
    }
  }
  prune(layout, version, layout.version)
  record('updated')
  await unlock(work, signal)
  if (!service.installed || (!service.running && !options.rollback))
    context.print(`restart phosphor run to use ${version}`)
  // An applied stage never touches pi's packages: Desktop's lanes share them.
  if (!options.rollback && options.apply === undefined) await updateClaudeProvider(context, signal)
  context.progress?.({ step: 'selected', version, installed: layout.version })
  context.print(`Selected Host ${version}.`)
  if (notice) context.print(notice)
  return 0
}

/**
 * `phosphor update`: fetch, verify, stage, select and restart, rolling back an
 * unhealthy release. `--stage` stops before selecting; `--apply <v>` selects a
 * staged release and restarts, after the caller paused the lanes; `--rollback`
 * selects the previous release offline; `--check` only reports.
 */
export async function runUpdate(
  context: UpdateContext,
  options: UpdateOptions = {},
): Promise<number> {
  return installLifetime(context.attach, async (signal) => {
    const work: UpdateWork = { selected: false }
    try {
      if (invalidOptions(options)) throw new UpdateFailure('Invalid update options.', 64)
      const layout = lockLayout(context, work, signal)
      const { apply } = options
      if (apply === layout.version) {
        await unlock(work, signal)
        context.print(`Host ${apply} is already selected.`)
        return 0
      }
      if (apply !== undefined && !installedVersion(layout, apply))
        throw new UpdateFailure(`Host ${apply} is not staged; run: phosphor update --stage`, 69)
      const target =
        apply !== undefined
          ? { version: apply }
          : options.rollback
            ? { version: previousVersion(layout) }
            : await fetchRelease(context, options, layout, work, signal)
      if (typeof target === 'number') return target
      return await selectAndRestart(context, options, layout, target, work, signal)
    } catch (error) {
      if (signal.aborted) return typeof signal.reason === 'number' ? signal.reason : 70
      context.print(
        error instanceof UpdateFailure ||
          (error instanceof Error && error.message.startsWith('Install lock:'))
          ? error.message
          : 'Host update failed; no unverified release was selected.',
      )
      return error instanceof UpdateFailure ? error.exitCode : 75
    } finally {
      if (work.stage) rmSync(work.stage, { recursive: true, force: true })
      const { published } = work
      if (
        published &&
        !work.selected &&
        realpathSync(join(published, '../../current')) !== published
      )
        rmSync(published, { recursive: true, force: true })
      work.release?.()
    }
  })
}
