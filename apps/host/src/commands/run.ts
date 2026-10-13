import { randomInt } from 'node:crypto'
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
  attach?: (target: Drainable) => () => void
  heartbeat?: Partial<Pick<HeartbeatPorts, 'readiness' | 'seq' | 'random'>>
}
async function runHostCommand(context: RunContext): Promise<number> {
  let store: HostStore | undefined
  let release: (() => Promise<void>) | undefined
  let detach: (() => void) | undefined
  let later: ShutdownSignal | undefined
  let drains = 0
  let released: () => void = () => {}
  const unlocked = new Promise<void>((resolve) => {
    released = resolve
  })
  try {
    const prepared = await withCommandLock(context, () => prepareControl(context))
    if (!prepared.loaded) {
      context.print('Run phosphor login first.')
      return 69
    }
    const directory = identityDirectory(context.configPath)
    release = await acquireIdentityLock(directory, context.uid, context.lockPorts, '.run-lock')
    const config = await loadHostConfig(context.configPath, context.uid)
    if (!config.ok)
      throw new IdentityFailure('Config is not usable. Run phosphor doctor to check it.')
    const stateDirectory = hostStateDirectory(context.env, context.home)
    try {
      store = await openStore(stateDirectory, context.uid)
      store.syncRepositories(config.config.repositories)
      const counts = await reconcile(store, (skipped) =>
        context.log?.('host', 'lanes.skipped', { skipped }),
      )
      context.log?.('host', 'lanes.reconciled', counts)
    } catch (error) {
      if (error instanceof StateFailure) throw error
      throw new StateFailure(stateDirectory, 70, 'Could not reconcile lanes.')
    }
    const { identity, key } = prepared.loaded
    const loop = createHeartbeat({
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
    detach = context.attach?.({
      ...loop,
      drain: async (reason) => {
        // Shutdown names the signal. Both drains now end together, after the
        // release, so the first signal's waiter must exit with a later one's code.
        if (drains++ > 0 && (SHUTDOWN_SIGNALS as readonly string[]).includes(reason))
          later = reason as ShutdownSignal
        const result = await loop.drain()
        await Promise.race([unlocked, setTimeout(RELEASE_WAIT_MS, undefined, { ref: false })])
        return result
      },
      exitCode: () => (later ? 128 + constants.signals[later] : loop.exitCode()),
      log: { write: () => {}, hide: () => 'The Host could not finish.' },
    })
    return await loop.run()
  } catch (error) {
    const result =
      error instanceof StateFailure
        ? { message: error.message, exitCode: error.exitCode }
        : controlResult(error, context.signal)
    context.print(result.message)
    return result.exitCode
  } finally {
    detach?.()
    try {
      store?.close()
    } finally {
      try {
        await release?.()
      } finally {
        released()
      }
    }
  }
}

export function runHost(context: RunContext): Promise<number> {
  return traceCommand(context, 'run', (traced) => runHostCommand({ ...context, ...traced }))
}
