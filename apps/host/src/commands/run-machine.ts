import { createWorkspaceLeases } from '../owner/lease'
import { isRoutineSession } from '@phosphor/session-runtime/routines/ownership'
import type { DaemonHeadroom } from '../session/headroom'
import { join } from 'node:path'
import { piSessionsRoot } from '@phosphor/session-runtime/pi/pi-paths'
import { seedArtifactSkill } from '@phosphor/session-runtime/bundled-skills'
import { hostLivePolicy } from '../config/live-policy'
import { createRepositories } from '../features/repositories'
import { createLaneCalls } from '../lanes/calls'
import { createLaneCommands } from '../lanes/commands'
import { ownerTrash } from '../lanes/delete-target'
import { transcriptTrash } from '../lanes/delete'
import { createHostLiveLanes } from '../lanes/live-host'
import { createLaneNamer, hostLaneNaming } from '../lanes/naming'
import { hostLanePausePorts } from '../lanes/pause'
import { createRuntimeLanes } from '../lanes/runtime-host'
import type { LaneService } from '../lanes/service'
import { hostStateDirectory } from '@phosphor/shared/host-local'
import type { HostStore } from '../lanes/store'
import { createHostLog, hostLogDirectory } from '../machine/log'
import type { HostClaudeAccounts } from '../providers/accounts'
import { createHostRoutines, routineOwnership } from '../routines/service'
import { createHostRuntime, type HostMachine } from '../session/runtime'
import type { AppServices } from '../session/app-services'
import { serviceRunner } from '../machine/systemd'
import { retireUpdateJobAtStart } from '../update/launchd-job'
import { inspectHost, type HostInspection } from './doctor'
import type { RunContext } from './run'
import {
  createRunAccounts,
  createRunAdministration,
  createRunControllerPresence,
  createRunTerminals,
} from './run-administration'
import type { ReceiptSink, StartWebPush } from './run-control'
import type { RunConfig } from './run-state'
import type { RunParts } from './run-teardown'
import { createRunServices } from './run-services'
import type { OpsAdapterPorts } from '../ops/adapter'
import type { Reach } from '@phosphor/session-runtime/ops/reach'
import type { OpsBinding } from '@phosphor/session-runtime/ops/types'
import { createRunEndings } from '../ops/lane-reload'
import type { HostOpsLanePorts } from '../session/contributions/ops'
import type { EnrolledControl } from './run-control'
import { bindRunOps, laneManagement } from './run-machine-ops'

/** What the machine needs from the rest of run: state it opened, and the control link's ports. */
export interface RunMachinePorts {
  appServices?: AppServices
  local?: boolean
  epoch: string
  config: RunConfig
  stateDirectory: string
  store: HostStore
  sink: ReceiptSink
  headroom?: DaemonHeadroom
  webPush: StartWebPush
  /** Agent control: run's slot, the identity control connects, and machine reach. */
  ops?: {
    slot: OpsAdapterPorts
    enrolled: { current: EnrolledControl | null }
    remote: NonNullable<OpsBinding['remote']>
    directory: Reach['directory']
  }
}

export type HostLog = ReturnType<typeof createHostLog>

/** P5: local mode leases a workspace to Desktop only while no live lane or routine holds it. */
function runLeases(context: RunContext, parts: RunParts) {
  return createWorkspaceLeases(
    () =>
      (parts.runtime?.list() ?? []).map(({ workspacePath, sessionId }) => ({
        workspacePath,
        reason: isRoutineSession(sessionId) ? 'routine' : 'live-lane',
      })),
    context.now,
  )
}

/** The runtime and what owns its lanes: live lanes, routines and the lane namer. */
async function startRuntime(
  context: RunContext,
  parts: RunParts,
  ports: RunMachinePorts,
  machine: Omit<HostMachine, 'log'>,
  log: HostLog,
) {
  const { config, store } = ports
  const trash = transcriptTrash(hostStateDirectory(context.env, context.home))
  await trash.sweep().catch(() => {})
  const accounts = createRunAccounts(context, ports.stateDirectory, machine.env, log.write)
  const leases = runLeases(context, parts)
  const opsLanes = {
    service: () => parts.ops ?? null,
    resourceRoot: () => machine.resourceRoot,
    unattended: new Set<string>(),
    endings: createRunEndings(),
    liveness: (sessionId: string, subagents: number) =>
      parts.services?.pauses?.liveness(sessionId, subagents),
  } satisfies HostOpsLanePorts
  const policy = hostLivePolicy(config.path, config.config)
  const runtime = createHostRuntime(
    { ...machine, log, appServices: ports.appServices, headroom: ports.headroom },
    {
      leases,
      claudeAccounts: accounts,
      ...policy,
      dialogs: 'forward',
      ...(ports.ops ? { ops: opsLanes } : {}),
      trashTranscript: trash.move,
      ownerTrashTranscript: ownerTrash(ports.local === true, context.platform, context.trashRunner),
      routines: routineOwnership(async (id) => {
        if (!parts.routines) throw new Error('routine service unavailable')
        await parts.routines.cancelSession(id)
      }),
    },
  )
  parts.runtime = runtime
  runtime.life.to('validating')
  seedArtifactSkill(
    machine.resourceRoot,
    context.env.PI_CODING_AGENT_DIR ?? join(context.home, '.pi', 'agent'),
  )
  runtime.life.to('ready')
  const hosted = createHostLiveLanes({
    epoch: ports.epoch,
    store,
    runtime,
    now: context.now ?? Date.now,
    log: log.write,
    sessionsRoot: piSessionsRoot(context.env, context.home),
    composerWindows: store.composerWindows,
    contextBudget: policy.contextBudget,
    pauseFor: (laneId) => parts.services?.pauses?.pauseFor(laneId),
  })
  const live = hosted.live
  parts.live = live
  const routines = createHostRoutines({
    directory: hostStateDirectory(context.env, context.home),
    uid: context.uid,
    store,
    runtime,
    changed: live.lanesTopic.routinesChanged,
    resourceChanged: live.lanesTopic.resourceChanged,
    now: context.now,
    paused: () => (parts.services?.pauses?.state().kind ?? 'none') !== 'none',
  })
  parts.routines = routines
  const nameLane = createLaneNamer(machine, hostLaneNaming(config, runtime, accounts))
  parts.nameLane = nameLane
  return {
    ...hosted,
    leases,
    accounts,
    runtime,
    routines,
    nameLane,
    opsLanes,
  }
}

export type StartedRuntime = Awaited<ReturnType<typeof startRuntime>>

/** The folder service; every writer of the folder records shares its queue. */
function runRepositories(
  context: RunContext,
  parts: RunParts,
  ports: RunMachinePorts,
  { runtime, live }: StartedRuntime,
) {
  return createRepositories({
    local: ports.local,
    home: context.home,
    configPath: ports.config.path,
    uid: context.uid,
    store: ports.store,
    live: (id) =>
      parts.store
        ?.listLanes()
        .some((l) => l.repositoryId === id && parts.live?.sessionFor(l.laneId) !== null) ?? false,
    resourceChanged: live.lanesTopic.resourceChanged,
    changed: (roots) => {
      runtime.replaceRoots(roots)
      live.lanesTopic.repositoriesChanged()
    },
  })
}

/** Lane commands over the runtime, with terminals, repositories and machine administration. */
export function createMachineCommands(
  context: RunContext,
  parts: RunParts,
  ports: RunMachinePorts,
  machine: Omit<HostMachine, 'log'>,
  log: HostLog,
  started: StartedRuntime,
  cataloguePi?: HostInspection['pi'],
) {
  const { config, store } = ports
  const { runtime, live, routines, nameLane } = started
  const binding = createRuntimeLanes({ runtime, store, live, log: log.write, nameLane })
  const terminals = createRunTerminals(context, {
    epoch: ports.epoch,
    store,
    log,
    env: machine.env,
  })
  parts.terminals = terminals
  const repositories = runRepositories(context, parts, ports, started)
  const { features, settingsOps, skills, ...administration } = createRunAdministration({
    context,
    configPath: config.path,
    env: machine.env,
    pi: machine.pi,
    cataloguePi,
    bindModelWindow: started.bindModelWindow,
    store,
    runtime,
    accounts: started.accounts,
    leases: started.leases,
    terminals,
    attachments: parts.attachments,
    binding,
    live,
    repositories,
    routines,
    hide: log.hide,
    log: log.write,
  })
  const commands = createLaneCommands({
    ...administration,
    leases: started.leases,
    repositories,
    attachments: parts.attachments,
    terminals,
    store,
    ...binding,
    runtime: binding,
    routines,
    pauses: parts.services?.pauses ?? undefined,
    sessionFor: live.sessionFor,
    openDialogs: live.openDialogs,
    dialogGuard: (laneId, response, client) =>
      parts.ops?.dialogGuard(laneId, response, client) ?? 'relay',
    summaryFor: live.summaryFor,
    publish: live.publish,
    deliver: (...args) => ports.sink.deliver(...args),
    now: context.now ?? Date.now,
    log: log.write,
  })
  parts.commands = commands
  const management = laneManagement(administration, binding, parts)
  return {
    features,
    commands,
    terminals,
    management,
    settingsOps,
    resources: { skills, repositories, routines },
    laneCommand: binding.command,
    writes: administration.writes,
  }
}

/** The machine services beside the lane service, with the pause over the started lanes. */
function startServices(
  context: RunContext,
  ports: RunMachinePorts,
  machine: Omit<HostMachine, 'log'>,
  log: HostLog,
  { live, routines, runtime }: StartedRuntime,
) {
  const pausePorts = hostLanePausePorts({
    store: ports.store,
    live,
    routines,
    runtime,
    now: context.now ?? Date.now,
    log: log.write,
  })
  return createRunServices(machine.shellEnvironment, ports.appServices, ports.headroom, pausePorts)
}

/**
 * Starts the machine: its runtime, live lanes, routines, terminals,
 * administration, commands and calls, wired into one `LaneService`.
 * A machine that is not usable starts nothing and serves no lanes.
 */
export async function startRunMachine(
  context: RunContext,
  parts: RunParts,
  ports: RunMachinePorts,
  signal: AbortSignal,
): Promise<{ lanes?: LaneService; accounts?: HostClaudeAccounts }> {
  const inspection = await inspectHost(context, { captureShell: true })
  signal.throwIfAborted()
  if (!inspection.machine) {
    context.log?.('host', 'lanes.unavailable', { reason: 'machine-unusable' })
    return {}
  }
  const machine = {
    ...inspection.machine,
    roots: ports.store.listRepositories().map((repo) => repo.path),
  }
  const log = createHostLog(hostLogDirectory(context.env, context.home), inspection.secrets)
  parts.log = log
  ports.headroom?.activate(machine.env)
  if (context.platform === 'darwin')
    retireUpdateJobAtStart(
      ports.stateDirectory,
      context.uid,
      serviceRunner(context.env, () => {}),
      (event, fields) => log.write('host', event, fields),
    )
  const started = await startRuntime(context, parts, ports, machine, log)
  const { live, runtime } = started
  parts.services = startServices(context, ports, machine, log, started)
  const {
    features: administrationFeatures,
    commands,
    terminals,
    ...opsCommands
  } = createMachineCommands(context, parts, ports, machine, log, started, inspection.pi)
  parts.webPush = await ports.webPush({
    lanesTopic: live.lanesTopic,
    receipt: (laneId) => calls.call('lane.receipt', { laneId }),
    log: log.write,
  })
  const webPush = parts.webPush
  const features = [...administrationFeatures(), ...(webPush ? [webPush.feature] : [])]
  const calls = createLaneCalls({
    features,
    store: ports.store,
    live,
    runtime,
    unattached: started.unattached,
    now: context.now ?? Date.now,
    log: log.write,
  })
  const lanes: LaneService = {
    terminals,
    epoch: ports.epoch,
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
    webPushKey: webPush?.publicKey,
    streams: live.streams,
    lanesTopic: live.lanesTopic,
    controllerPresence: createRunControllerPresence(ports.store, live),
  }
  await bindRunOps(context, parts, ports, { ...started, ...opsCommands, machine, log, lanes })
  started.routines.start()
  return { lanes, accounts: started.accounts }
}
