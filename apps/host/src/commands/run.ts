import { createAuthority } from '../api/authority'
import { startApi } from '../api/server'
import { randomBytes, randomInt } from 'node:crypto'
import { parseHeartbeatResponse } from '@phosphor/shared/control-api'
import { healthWriter } from '../update/health'
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
import { checkReadiness, readinessPorts } from '../machine/readiness'
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
import { inspectHost } from './doctor'
import { createHostLog, hostLogDirectory } from '../machine/log'
import { createHostRuntime, type HostRuntime } from '../session/runtime'
import { createLiveLanes } from '../lanes/live'
import { createRuntimeLanes } from '../lanes/runtime-host'
import { createUnattachedSnapshots } from '../lanes/transcript'
import { createLaneCommands } from '../lanes/commands'
import { createLaneCalls } from '../lanes/calls'
import type { LaneService } from '../lanes/service'
import type { Receipt } from '@phosphor/shared/host-protocol'
import { seedArtifactSkill } from '@phosphor/session-runtime/bundled-skills'
import { join } from 'node:path'

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
async function runHostCommand(context: RunContext): Promise<number> {
  let api: ReturnType<typeof startApi> | undefined
  let runtime: HostRuntime | undefined
  let runtimeDrain: ReturnType<HostRuntime['drain']> | undefined
  let live: ReturnType<typeof createLiveLanes> | undefined
  let commands: ReturnType<typeof createLaneCommands> | undefined
  let lanes: LaneService | undefined
  // Part I assigns the API adapter's functions to this deferred sink.
  const sink: {
    deliver(clientId: string, receipt: Receipt, connectionId?: string): void
    isConnected(clientId: string): boolean
  } = { deliver: () => {}, isConnected: () => false }
  let launchApi: (() => void) | undefined
  const authority = createAuthority(context.now ?? Date.now)
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
        const stoppingApi = api?.stop()
        runtimeDrain ??= runtime?.drain('run finished')
        await Promise.all([stoppingApi, runtimeDrain])
        await commands?.close()
        live?.close()
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
        const stoppingApi = api?.stop()
        if (runtime) {
          if (!runtimeDrain) runtimeDrain = runtime.drain(reason)
          else void runtime.drain(reason)
        }
        let result: { state: 'stopped' | 'failed' }
        if (loop) result = await loop.drain()
        else {
          await initialization?.catch(() => {})
          result = { state: 'stopped' }
        }
        await Promise.all([stoppingApi, runtimeDrain])
        if (runtimeDrain && (await runtimeDrain).state === 'failed') result = { state: 'failed' }
        await Promise.race([unlocked, setTimeout(RELEASE_WAIT_MS, undefined, { ref: false })])
        return result
      },
      exitCode: (_reason, clean) =>
        !clean ? 70 : later ? 128 + constants.signals[later] : (loop?.exitCode() ?? startupExit),
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
          isConnected: (id) => sink.isConnected(id),
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
      const epoch = randomBytes(8).toString('hex')
      const inspection = await inspectHost(context)
      initAbort.signal.throwIfAborted()
      if (inspection.machine) {
        const machine = inspection.machine
        const log = createHostLog(hostLogDirectory(context.env, context.home), inspection.secrets)
        runtime = createHostRuntime({ ...machine, log }, { dialogs: 'forward' })
        runtime.life.to('validating')
        seedArtifactSkill(
          machine.resourceRoot,
          context.env.PI_CODING_AGENT_DIR ?? join(context.home, '.pi', 'agent'),
        )
        runtime.life.to('ready')
        let unattached: ReturnType<typeof createUnattachedSnapshots> = () => null
        live = createLiveLanes({
          epoch,
          store,
          runtime,
          now: context.now ?? Date.now,
          log: (event, fields) => log.write('host', event, fields),
          unattached: (id) => unattached(id),
        })
        unattached = createUnattachedSnapshots({
          store,
          summary: live.summaryFor,
          cursor: live.streams.cursor,
          sessionsRoot: piSessionsRoot(context.env, context.home),
          log: (event, fields) => log.write('host', event, fields),
        })
        const binding = createRuntimeLanes({ runtime, store, live, log: log.write })
        commands = createLaneCommands({
          store,
          ...binding,
          runtime: binding,
          sessionFor: live.sessionFor,
          openDialogs: live.openDialogs,
          summaryFor: live.summaryFor,
          publish: live.publish,
          deliver: (...args) => sink.deliver(...args),
          now: context.now ?? Date.now,
          log: log.write,
        })
        const calls = createLaneCalls({
          store,
          live,
          runtime,
          unattached,
          now: context.now ?? Date.now,
          log: log.write,
        })
        const activeLive = live
        const activeStore = store
        lanes = {
          epoch,
          capabilities: ['sessions.read', 'sessions.control'],
          commands,
          calls,
          streams: live.streams,
          lanesTopic: live.lanesTopic,
          controllerPresence(clientId) {
            for (const lane of activeStore.listLanes())
              if (lane.control.controller?.clientId === clientId)
                activeLive.publish(lane.laneId, { kind: 'control', control: lane.control })
          },
        }
      } else context.log?.('host', 'lanes.unavailable', { reason: 'machine-unusable' })
      initAbort.signal.throwIfAborted()
      launchApi = () => {
        const options = {
          runtimeEpoch: epoch,
          lanes,
          authority,
          origin: prepared.url,
          hostId: identity.hostId,
          hostVersion: HOST_VERSION,
          key,
          port: config.config.api?.port,
          fetch: context.fetch,
          log: (event: string, fields: Record<string, unknown>) =>
            context.log?.('host', event, fields),
        }
        api = startApi(options)
      }
      let endpoint: string | null = null
      let routeState = ''
      const accepted = healthWriter(
        stateDirectory,
        context.uid,
        HOST_VERSION,
        context.now ?? Date.now,
      )
      loop = createHeartbeat({
        endpoint: () => endpoint,
        onAccepted: authority.accept,
        onRemoved: authority.remove,
        now: context.now ?? Date.now,
        wait: context.wait ?? ((ms, signal) => setTimeout(ms, undefined, { signal })),
        random: context.heartbeat?.random ?? (() => randomInt(3001) / 3000),
        client: async (body, signal) => {
          context.log?.('host', 'heartbeat', {
            seq: body.seq,
            state: body.state,
            trace: context.trace,
          })
          const answer = await prepared.client.heartbeat(identity.hostId, key, body, signal)
          if (body.state === 'running' && !signal.aborted && parseHeartbeatResponse(answer).ok)
            accepted()
          return answer
        },
        readiness:
          context.heartbeat?.readiness ??
          (() =>
            checkReadiness(
              config.config,
              context.env,
              context.platform,
              context.heartbeat?.readinessPorts ?? readinessPorts,
              (found) => {
                endpoint = found.endpoint
                if (routeState !== found.state) {
                  routeState = found.state
                  context.log?.('host', 'tailscale.endpoint', { state: found.state })
                }
              },
            )),
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
    launchApi?.()
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
