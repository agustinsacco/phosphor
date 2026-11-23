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
import type { LocalModeFile } from '@phosphor/shared/host-local'
import type { ControlLink } from '../control/link'
import {
  createReceiptSink,
  createRunLink,
  runWebPush,
  type EnrolledControl,
  type ReceiptSink,
  type StartWebPush,
} from './run-control'
import {
  createLocalDaemon,
  runLocalMode,
  type LocalSocket,
  type StartLocalSocket,
} from './run-local'
import { createLaneAdapter, type LaneAdapter } from '../api/lanes'
import type { LaneService } from '../lanes/service'
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
  /** Local mode only: starts the owner socket (D3). */
  startLocalSocket?: StartLocalSocket
}

/** What run starts with: the identity it found and, in local mode, the marker. */
interface RunStart {
  initial: EnrolledControl | null
  mode: LocalModeFile | null
  directory: string
}

/**
 * One lane adapter for both listeners (V-D2.R3): receipts and presence reach a
 * client on either, and the socket serves the lanes once they exist.
 */
function shareLanes(
  context: RunContext,
  parts: RunParts,
  sink: ReceiptSink,
  lanes: LaneService | undefined,
  socket: LocalSocket | undefined,
): LaneAdapter | undefined {
  if (!lanes) return undefined
  const adapter = createLaneAdapter(lanes, {
    log: (event, fields) => context.log?.('host', event, fields),
  })
  sink.deliver = adapter.deliver
  sink.isConnected = adapter.isConnected
  parts.socketLanes = socket?.serveLanes?.({
    service: lanes,
    adapter,
    peers: () => parts.api?.connections() ?? [],
  })
  return adapter
}

/**
 * Opens state; in local mode starts the socket seam and waits until the daemon
 * owns the machine's lanes; then starts the machine and builds the control link.
 */
async function startRun(
  context: RunContext,
  parts: RunParts,
  sink: ReceiptSink,
  start: RunStart,
  signal: AbortSignal,
): Promise<ControlLink> {
  const { config, stateDirectory, store } = await openRunState(context, parts, sink, signal)
  signal.throwIfAborted()
  const local = start.mode ? createLocalDaemon(context, start.mode) : undefined
  const socket = await local?.own(parts, store, signal)
  signal.throwIfAborted()
  const epoch = randomBytes(8).toString('hex')
  // Web Push needs the identity run started with; a later enrollment gets it on the next start.
  const webPush: StartWebPush = start.initial
    ? runWebPush(context, start.initial)
    : async () => undefined
  const ports = {
    epoch,
    config,
    stateDirectory,
    store,
    sink,
    webPush,
    appServices: socket?.appServices,
  }
  const machine = await startRunMachine(context, parts, ports, signal)
  signal.throwIfAborted()
  const laneAdapter = shareLanes(context, parts, sink, machine.lanes, socket)
  const link = createRunLink(context, parts, sink, {
    ...machine,
    laneAdapter,
    peers: () => socket?.connections?.() ?? [],
    initial: start.initial,
    local: local !== undefined,
    enroll: local?.enroll,
    directory: start.directory,
    config,
    epoch,
    stateDirectory,
  })
  local?.attach(link)
  return link
}

/**
 * Prepares control, takes the run lock, attaches the drain, opens state,
 * starts the machine, then the API and the heartbeat, and tears down in order.
 * Without the local-mode marker, unenrolled exits 69 before the run lock and a
 * removed Host's heartbeat exits 77. With it, run starts unenrolled and a 410
 * stops only the TCP API.
 */
async function runHostCommand(context: RunContext): Promise<number> {
  const parts: RunParts = {}
  const teardown = createRunTeardown(parts)
  const sink = createReceiptSink()
  const initAbort = new AbortController()
  let initialization: Promise<void> | undefined
  let link: ControlLink | undefined
  let detach: (() => void) | undefined
  try {
    const prepared = await withCommandLock(context, () => prepareControl(context))
    const mode = runLocalMode(context)
    if (!prepared.loaded && !mode) {
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
    const { client, url, loaded } = prepared
    const authority = createAuthority(context.now ?? Date.now)
    const initial = loaded ? { ...loaded, client, url, directory, authority } : null
    // Start-up can await SQLite and disk scans. A signal must wait for cleanup
    // here too, not just once the heartbeat loop is running.
    detach = context.attach?.(
      teardown.drainTarget({
        abort: () => initAbort.abort(),
        loop: () => link,
        initialization: () => initialization,
      }),
    )
    initialization = (async () => {
      link = await startRun(context, parts, sink, { initial, mode, directory }, initAbort.signal)
    })()
    await initialization
    initAbort.signal.throwIfAborted()
    if (!link) throw new Error('Control link was not initialized.')
    link.start()
    return await link.run()
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
