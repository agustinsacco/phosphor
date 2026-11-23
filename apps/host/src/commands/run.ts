import { randomBytes } from 'node:crypto'
import { createAuthority } from '../api/authority'
import {
  controlResult,
  traceCommand,
  prepareControl,
  withCommandLock,
  type ControlContext,
} from '../control/command'
import type { HeartbeatPorts } from '../control/heartbeat'
import { identityDirectory } from '../control/identity'
import { acquireIdentityLock } from '../control/lock'
import type { loadHostConfig } from '../config/load'
import type { readinessPorts } from '../machine/readiness'
import type { Drainable } from '../shutdown'
import {
  launchdExit,
  permanentServiceReason,
  prepareLaunchdRun,
  type LaunchdRunPorts,
} from '../machine/launchd'
import { StateFailure } from '../lanes/state-dir'
import type { reconcile } from '../lanes/reconcile'
import {
  createReceiptSink,
  createRunHeartbeat,
  runWebPush,
  startRunApi,
  type EnrolledControl,
} from './run-control'
import { startRunMachine } from './run-machine'
import { openRunState } from './run-state'
import { createRunTeardown, type RunParts } from './run-teardown'

export { RELEASE_WAIT_MS } from './run-teardown'

export interface RunContext extends ControlContext {
  env: NodeJS.ProcessEnv
  home: string
  nodeVersion: string
  defaultResourceRoot: string
  supervisor?: 'launchd'
  afterRunLock?: () => void
  stderrIdentity?: LaunchdRunPorts['stderrIdentity']
  attach?: (target: Drainable) => () => void
  heartbeat?: Partial<Pick<HeartbeatPorts, 'readiness' | 'seq' | 'random'>> & {
    readinessPorts?: typeof readinessPorts
  }
  loadConfig?: typeof loadHostConfig
  reconcile?: typeof reconcile
}

/**
 * Prepares control, takes the run lock, attaches the drain, opens state,
 * starts the machine, then the API and the heartbeat, and tears down in order.
 * Unenrolled exits 69 before the run lock; a removed Host's heartbeat exits 77.
 */
async function runHostCommand(context: RunContext): Promise<number> {
  const parts: RunParts = {}
  const teardown = createRunTeardown(parts)
  const sink = createReceiptSink()
  const authority = createAuthority(context.now ?? Date.now)
  const initAbort = new AbortController()
  let initialization: Promise<void> | undefined
  let loop: ReturnType<typeof createRunHeartbeat> | undefined
  let launchApi: (() => void) | undefined
  let detach: (() => void) | undefined
  try {
    const prepared = await withCommandLock(context, () => prepareControl(context))
    if (!prepared.loaded) {
      context.print('Run phosphor setup first.')
      return 69
    }
    const directory = identityDirectory(context.configPath)
    parts.release = await acquireIdentityLock(
      directory,
      context.uid,
      context.lockPorts,
      '.run-lock',
    )
    context.afterRunLock?.()
    const { client, url } = prepared
    const control: EnrolledControl = { ...prepared.loaded, client, url, directory, authority }
    // Start-up can await SQLite and disk scans. A signal must wait for cleanup
    // here too, not just once the heartbeat loop is running.
    detach = context.attach?.(
      teardown.drainTarget({
        abort: () => initAbort.abort(),
        loop: () => loop,
        initialization: () => initialization,
      }),
    )
    initialization = (async () => {
      const signal = initAbort.signal
      const { config, stateDirectory, store } = await openRunState(context, parts, sink, signal)
      signal.throwIfAborted()
      const epoch = randomBytes(8).toString('hex')
      const webPush = runWebPush(context, control)
      const ports = { epoch, config, stateDirectory, store, sink, webPush }
      const machine = await startRunMachine(context, parts, ports, signal)
      signal.throwIfAborted()
      launchApi = () =>
        startRunApi(context, parts, sink, { control, config, epoch, lanes: machine.lanes })
      const { accounts } = machine
      loop = createRunHeartbeat(context, { control, config, stateDirectory, accounts })
    })()
    await initialization
    initAbort.signal.throwIfAborted()
    launchApi?.()
    if (!loop) throw new Error('Heartbeat was not initialized.')
    return await loop.run()
  } catch (error) {
    if (error === initAbort.signal.reason && initAbort.signal.aborted) {
      teardown.abortedCleanly()
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
    await teardown.closeAndRelease()
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
