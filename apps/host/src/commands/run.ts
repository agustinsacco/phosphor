import { randomInt } from 'node:crypto'
import { piSessionsRoot } from '@phosphor/session-runtime/pi/pi-paths'
import { constants } from 'node:os'
import { setTimeout } from 'node:timers/promises'
import {
  controlResult,
  traceCommand,
  prepareControl,
  withCommandLock,
  type ControlContext,
} from '../control/command'
import {
  REMOVED,
  createHeartbeat,
  createSequenceStore,
  type HeartbeatPorts,
} from '../control/heartbeat'
import { identityDirectory, IdentityFailure } from '../control/identity'
import { acquireIdentityLock } from '../control/lock'
import { loadHostConfig } from '../config/load'
import { checkReadiness } from '../machine/readiness'
import { SHUTDOWN_SIGNALS, type Drainable, type ShutdownSignal } from '../shutdown'
import {
  launchdExit,
  permanentServiceReason,
  prepareLaunchdRun,
  type LaunchdRunPorts,
} from '../machine/launchd'
import { HOST_VERSION } from '../version'
import { hostStateDirectory, StateFailure } from '../lanes/state-dir'
import { openStore, type HostStore } from '../lanes/store'
import { reconcile } from '../lanes/reconcile'

/**
 * Shutdown exits as soon as the attached drain ends. A drain that ended before
 * the run lock was released let a Ctrl-C exit inside the release, leaving
 * identity/.run-lock-recovery behind, and every later run refused to start.
 * The drain therefore also waits for the release, for at most this long.
 */
export const RELEASE_WAIT_MS = 3000

export interface RunContext extends ControlContext {
  env: NodeJS.ProcessEnv
  home: string
  supervisor?: 'launchd'
  afterRunLock?: () => void
  stderrIdentity?: LaunchdRunPorts['stderrIdentity']
  attach?: (target: Drainable) => () => void
  heartbeat?: Partial<Pick<HeartbeatPorts, 'readiness' | 'seq' | 'random'>>
  loadConfig?: typeof loadHostConfig
  reconcile?: typeof reconcile
}
async function runHostCommand(context: RunContext): Promise<number> {
  let store: HostStore | undefined
  let release: (() => Promise<void>) | undefined
  let detach: (() => void) | undefined
  let later: ShutdownSignal | undefined
  let drains = 0
  const initAbort = new AbortController()
  let initialization: Promise<void> | undefined
  let loop: ReturnType<typeof createHeartbeat> | undefined
  let startupExit = 70
  let released: () => void = () => {}
  const unlocked = new Promise<void>((resolve) => {
    released = resolve
  })
  const closeAndRelease = async () => {
    try {
      try {
        store?.close()
      } finally {
        await release?.()
      }
    } catch (error) {
      startupExit = 70
      throw error
    } finally {
      released()
    }
  }
  try {
    const prepared = await withCommandLock(context, () => prepareControl(context))
    if (!prepared.loaded) {
      context.print('Run phosphor login first.')
      return 69
    }
    const { identity, key } = prepared.loaded
    const directory = identityDirectory(context.configPath)
    release = await acquireIdentityLock(directory, context.uid, context.lockPorts, '.run-lock')
    context.afterRunLock?.()
    // Start-up can await SQLite and disk scans. A signal must wait for cleanup
    // here too, not just once the heartbeat loop is running.
    detach = context.attach?.({
      drain: async (reason) => {
        if (drains++ > 0 && (SHUTDOWN_SIGNALS as readonly string[]).includes(reason))
          later = reason as ShutdownSignal
        initAbort.abort()
        let result: { state: 'stopped' | 'failed' }
        if (loop) result = await loop.drain()
        else {
          await initialization?.catch(() => {})
          result = { state: 'stopped' }
        }
        await Promise.race([unlocked, setTimeout(RELEASE_WAIT_MS, undefined, { ref: false })])
        return result
      },
      exitCode: () => (later ? 128 + constants.signals[later] : (loop?.exitCode() ?? startupExit)),
      log: { write: () => {}, hide: () => 'The Host could not finish.' },
    })
    initialization = (async () => {
      initAbort.signal.throwIfAborted()
      const config = await (context.loadConfig ?? loadHostConfig)(context.configPath, context.uid)
      initAbort.signal.throwIfAborted()
      if (!config.ok)
        throw new IdentityFailure('Config is not usable. Run phosphor doctor to check it.')
      const stateDirectory = hostStateDirectory(context.env, context.home)
      try {
        initAbort.signal.throwIfAborted()
        store = await openStore(stateDirectory, context.uid, {
          logCorruptReceipt: (count) => context.log?.('host', 'receipts.corrupt', { count }),
          logCorruptLane: (count) => context.log?.('host', 'lanes.corrupt', { count }),
        })
        initAbort.signal.throwIfAborted()
        store.syncRepositories(config.config.repositories, (count) =>
          context.log?.('host', 'lanes.repositories_unavailable', { count }),
        )
        initAbort.signal.throwIfAborted()
        const counts = await (context.reconcile ?? reconcile)(
          store,
          piSessionsRoot(context.env, context.home),
          (skipped) => context.log?.('host', 'lanes.skipped', { skipped }),
          initAbort.signal,
        )
        initAbort.signal.throwIfAborted()
        context.log?.('host', 'lanes.reconciled', counts)
      } catch (error) {
        if (error instanceof StateFailure || error === initAbort.signal.reason) throw error
        throw new StateFailure(stateDirectory, 70, 'Could not reconcile lanes.')
      }
      initAbort.signal.throwIfAborted()
      loop = createHeartbeat({
        now: context.now ?? Date.now,
        wait: context.wait ?? ((ms, signal) => setTimeout(ms, undefined, { signal })),
        random: context.heartbeat?.random ?? (() => randomInt(3001) / 3000),
        client: (body, signal) => {
          context.log?.('host', 'heartbeat', {
            seq: body.seq,
            state: body.state,
            trace: context.trace,
          })
          return prepared.client.heartbeat(identity.hostId, key, body, signal)
        },
        readiness:
          context.heartbeat?.readiness ??
          (() => checkReadiness(config.config, context.env, context.platform)),
        seq: context.heartbeat?.seq ?? createSequenceStore(directory, context.uid, identity.hostId),
        hostVersion: HOST_VERSION,
        signal: context.signal,
        log: (line) => {
          const retry = /^retrying in ([0-9.]+)s$/.exec(line)
          context.log?.('host', line === REMOVED ? 'removed' : retry ? 'retry' : 'state', {
            state: line,
            trace: context.trace,
            ...(line === REMOVED ? { exitCode: 77 } : {}),
            ...(retry ? { delayMs: Number(retry[1]) * 1000 } : {}),
          })
          context.print(line)
        },
      })
    })()
    await initialization
    initAbort.signal.throwIfAborted()
    if (!loop) throw new Error('Heartbeat was not initialized.')
    return await loop.run()
  } catch (error) {
    if (error === initAbort.signal.reason && initAbort.signal.aborted) {
      startupExit = 0
      return 0
    }
    const result =
      error instanceof StateFailure
        ? { message: error.message, exitCode: error.exitCode }
        : controlResult(error, context.signal)
    context.print(result.message)
    return result.exitCode
  } finally {
    detach?.()
    await closeAndRelease()
  }
}

export function runHost(context: RunContext): Promise<number> {
  return traceCommand(context, 'run', async (traced) => {
    if (context.supervisor !== 'launchd') return runHostCommand({ ...context, ...traced })
    if (!context.home) {
      context.print('The service command could not finish.')
      return 75
    }
    try {
      const home = context.home
      const code = await runHostCommand({
        ...context,
        ...traced,
        afterRunLock: () =>
          prepareLaunchdRun(context.env, home, {
            uid: context.uid,
            stderrIdentity: context.stderrIdentity,
            log: traced.log,
          }),
      })
      if (permanentServiceReason(code)) traced.log?.('service', 'stopped', { code })
      return await launchdExit(code, context.env, context.home, context.now?.() ?? Date.now())
    } catch {
      context.print('The service command could not finish.')
      return 75
    }
  })
}
