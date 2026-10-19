import { createRepositories } from '../features/repositories'
import { createLaneDeletion, transcriptTrash } from '../lanes/delete'
import type { HostClaudeAccounts } from '../providers/accounts'
import {
  createRunAccounts,
  createRunAdministration,
  createRunControllerPresence,
  runReadiness,
} from './run-administration'
import { realpathSync } from 'node:fs'
import { createAttachments, type HostAttachments } from '../features/attachments'
import { loadHostPty } from '../terminals/native'
import { createTerminals, type HostTerminals } from '../terminals/service'
import { terminalState } from '../terminals/state'
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
import type { readinessPorts } from '../machine/readiness'
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
import { createLaneNamer } from '../lanes/naming'
import { createRuntimeLanes } from '../lanes/runtime-host'
import { createUnattachedSnapshots } from '../lanes/transcript'
import { createLaneCommands } from '../lanes/commands'
import { createLaneCalls } from '../lanes/calls'
import type { LaneService } from '../lanes/service'
import type { Receipt } from '@phosphor/shared/host-protocol'
import { seedArtifactSkill } from '@phosphor/session-runtime/bundled-skills'
import { join } from 'node:path'
import { createHostRoutines, routineOwnership, type HostRoutines } from '../routines/service'

/**
 * Shutdown exits as soon as the attached drain ends. A drain that ended before
 * the run lock was released let a Ctrl-C exit inside the release, leaving
 * identity/.run-lock-recovery behind, and every later run refused to start.
 * The drain therefore also waits for the release, for at most this long.
 */
export const RELEASE_WAIT_MS = 3000

/** Runs `step` so a synchronous throw becomes a rejection and cannot skip the steps after it. */
const attempt = async (step: () => unknown): Promise<unknown> => step()
/** Waits for every promise to settle, then returns the first failure in list order. */
async function firstFailure(pending: unknown[]): Promise<PromiseRejectedResult | undefined> {
  const results = await Promise.allSettled(pending)
  return results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
}

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
  let routines: HostRoutines | undefined
  let routinesStop: Promise<void> | undefined
  let nameLane: ReturnType<typeof createLaneNamer> | undefined
  let claudeAccounts: HostClaudeAccounts | undefined
  let activeLog: ReturnType<typeof createHostLog> | undefined
  let runtime: HostRuntime | undefined
  let runtimeDrain: ReturnType<HostRuntime['drain']> | undefined
  let live: ReturnType<typeof createLiveLanes> | undefined
  let commands: ReturnType<typeof createLaneCommands> | undefined
  let terminals: HostTerminals | undefined
  let lanes: LaneService | undefined
  // The store opens before the API; defer receipt delivery and presence until it starts.
  const sink: {
    deliver(clientId: string, receipt: Receipt, connectionId?: string): void
    isConnected(clientId: string): boolean
  } = { deliver: () => {}, isConnected: () => false }
  let launchApi: (() => void) | undefined
  const authority = createAuthority(context.now ?? Date.now)
  let attachments: HostAttachments | undefined
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
  // Set before `unlocked` resolves, so a signal's drain fails with it too.
  let teardownFailure: PromiseRejectedResult | undefined
  const closeAndRelease = async () => {
    // The stops start together, and nothing closes until all of them have settled.
    const failures = [
      await firstFailure([
        attempt(() => nameLane?.cancel()),
        attempt(() => api?.stop()),
        attempt(() => (routinesStop ??= routines?.stop())),
        attempt(() => (runtimeDrain ??= runtime?.drain('run finished'))),
      ]),
    ]
    // Then one at a time, whatever failed: the store closes only after its last user.
    for (const close of [
      () => commands?.close(),
      () => terminals?.close(),
      () => attachments?.close(),
      () => routines?.close(),
      () => live?.close(),
      () => store?.close(),
      () => release?.(),
    ])
      failures.push(await firstFailure([attempt(close)]))
    teardownFailure = failures.find((result) => result !== undefined)
    released()
    if (teardownFailure) {
      startupExit = 70
      throw teardownFailure.reason
    }
  }
  try {
    const prepared = await withCommandLock(context, () => prepareControl(context))
    if (!prepared.loaded) {
      context.print('Run phosphor setup first.')
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
        // Settled from the start, so a failed stop is never unhandled, and it
        // still waits for the release below before the drain rejects.
        const stopping = firstFailure([
          attempt(() => nameLane?.cancel()),
          attempt(() => api?.stop()),
          attempt(() => (routinesStop ??= routines?.stop())),
          attempt(() => {
            if (!runtime) return
            if (!runtimeDrain) runtimeDrain = runtime.drain(reason)
            else void runtime.drain(reason)
            return runtimeDrain
          }),
        ])
        let result: { state: 'stopped' | 'failed' }
        if (loop) result = await loop.drain()
        else {
          await initialization?.catch(() => {})
          result = { state: 'stopped' }
        }
        // Start-up may have created the runtime or routines since: wait for those too.
        const drainingRuntime = runtimeDrain
        const failure = (await stopping) ?? (await firstFailure([drainingRuntime, routinesStop]))
        if (!failure && (await drainingRuntime)?.state === 'failed') result = { state: 'failed' }
        await Promise.race([unlocked, setTimeout(RELEASE_WAIT_MS, undefined, { ref: false })])
        // A teardown step that failed after this drain's own stops fails the signal's exit too.
        const failed = failure ?? teardownFailure
        if (failed) throw failed.reason
        return result
      },
      exitCode: (_reason, clean) =>
        !clean ? 70 : later ? 128 + constants.signals[later] : (loop?.exitCode() ?? startupExit),
      log: {
        write: (...args) => activeLog?.write(...args),
        hide: () => 'The Host could not finish.',
      },
    })
    initialization = (async () => {
      initAbort.signal.throwIfAborted()
      const config = await (context.loadConfig ?? loadHostConfig)(context.configPath, context.uid)
      initAbort.signal.throwIfAborted()
      if (!config.ok)
        throw new IdentityFailure('Config is not usable. Run phosphor setup to check it.')
      const stateDirectory = hostStateDirectory(context.env, context.home)
      try {
        initAbort.signal.throwIfAborted()
        store = await openStore(stateDirectory, context.uid, {
          onLaneRemoved: (laneId) => attachments?.remove(laneId),
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
        attachments = createAttachments({
          log: (event) => context.log?.('host', event, {}),
          directory: realpathSync(stateDirectory),
          laneExists: (laneId) => store?.getLane(laneId)?.removedAt === null,
          now: context.now,
        })
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
        activeLog = log
        const trash = transcriptTrash(hostStateDirectory(context.env, context.home))
        await trash.sweep().catch(() => {})
        claudeAccounts = createRunAccounts(context, stateDirectory, machine.env)
        runtime = createHostRuntime(
          { ...machine, log },
          {
            claudeAccounts,
            dialogs: 'forward',
            trashTranscript: trash.move,
            routines: routineOwnership(async (id) => {
              if (!routines) throw new Error('routine service unavailable')
              await routines.cancelSession(id)
            }),
          },
        )
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
        const activeTopic = live.lanesTopic
        routines = createHostRoutines({
          directory: hostStateDirectory(context.env, context.home),
          uid: context.uid,
          store,
          runtime,
          changed: () => activeTopic.routinesChanged(),
          now: context.now,
        })
        nameLane = config.config.autoNameLanes === false ? undefined : createLaneNamer(machine)
        const binding = createRuntimeLanes({
          runtime,
          store,
          live,
          log: log.write,
          nameLane,
        })
        const native = loadHostPty()
        if (native)
          terminals = createTerminals({
            native,
            epoch,
            env: machine.env,
            context: {
              store,
              env: context.env,
              home: context.home,
              log: (event, fields) => log.write('host', event, fields),
            },
            ...terminalState(stateDirectory),
          })
        const activeRuntime = runtime
        const repositories = createRepositories({
          home: context.home,
          configPath: config.path,
          uid: context.uid,
          store,
          live: (id) =>
            store
              ?.listLanes()
              .some((l) => l.repositoryId === id && live?.sessionFor(l.laneId) !== null) ?? false,
          changed: (roots) => {
            activeRuntime.replaceRoots(roots)
            activeTopic.repositoriesChanged()
          },
        })
        const administration = createRunAdministration({
          context,
          configPath: config.path,
          env: machine.env,
          pi: machine.pi,
          store,
          runtime: activeRuntime,
          accounts: claudeAccounts,
          terminals,
          binding,
          live,
          repositories,
          routines,
          log: log.write,
        })
        commands = createLaneCommands({
          moveClaudeAccount: administration.moveClaudeAccount,
          repositories,
          machineTasks: administration.machineTasks,
          deleteLane: createLaneDeletion({
            store,
            stop: binding.deleteStop,
            remove: runtime.remove,
            forget: live.forget,
          }),
          providerLogins: administration.providerLogins,
          attachments,
          terminals,
          writes: administration.writes,
          store,
          ...binding,
          runtime: binding,
          routines,
          sessionFor: live.sessionFor,
          openDialogs: live.openDialogs,
          summaryFor: live.summaryFor,
          publish: live.publish,
          deliver: (...args) => sink.deliver(...args),
          now: context.now ?? Date.now,
          log: log.write,
        })
        const features = administration.features()
        const calls = createLaneCalls({
          features,
          store,
          live,
          runtime,
          unattached,
          now: context.now ?? Date.now,
          log: log.write,
        })
        lanes = {
          terminals,
          epoch,
          capabilities: [
            ...new Set([
              'sessions.read' as const,
              'sessions.control' as const,
              'workspaces.write' as const,
              ...features.map((feature) => feature.capability),
            ]),
          ],
          commands,
          calls,
          streams: live.streams,
          lanesTopic: live.lanesTopic,
          controllerPresence: createRunControllerPresence(store, live),
        }
        routines.start()
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
          webOrigin: config.config.api?.webOrigin,
          fetch: context.fetch,
          log: (event: string, fields: Record<string, unknown>) =>
            context.log?.('host', event, fields),
        }
        api = startApi(options)
        sink.deliver = api.deliver
        sink.isConnected = api.isConnected
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
            runReadiness(config.config, context, claudeAccounts, (found) => {
              endpoint = found.endpoint
              if (routeState !== found.state) {
                routeState = found.state
                context.log?.('host', 'tailscale.endpoint', { state: found.state })
              }
            })),
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
