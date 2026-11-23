import { createWorkspaceLeases } from '../owner/lease'
import { isRoutineSession } from '@phosphor/session-runtime/routines/ownership'
import type { DaemonHeadroom } from '../session/headroom'
import { dirname, join, resolve } from 'node:path'
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
import { hostStateDirectory } from '../lanes/state-dir'
import type { HostStore } from '../lanes/store'
import { createHostLog, hostLogDirectory } from '../machine/log'
import type { HostClaudeAccounts } from '../providers/accounts'
import { createHostRoutines, routineOwnership } from '../routines/service'
import { createHostRuntime, type HostMachine } from '../session/runtime'
import type { AppServices } from '../session/app-services'
import { serviceRunner } from '../machine/systemd'
import { retireUpdateJobAtStart } from '../update/launchd-job'
import { inspectHost } from './doctor'
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
import type { OpsBinding } from '@phosphor/session-runtime/ops/types'
import { startRunOps } from '../ops/service'
import type { HostOpsLanePorts } from '../session/contributions/ops'
import type { EnrolledControl } from './run-control'

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
  }
}

type HostLog = ReturnType<typeof createHostLog>

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
  const accounts = createRunAccounts(context, ports.stateDirectory, machine.env)
  const leases = ports.local
    ? createWorkspaceLeases(
        () =>
          (parts.runtime?.list() ?? []).map(({ workspacePath, sessionId }) => ({
            workspacePath,
            reason: isRoutineSession(sessionId) ? 'routine' : 'live-lane',
          })),
        context.now,
      )
    : undefined
  const opsLanes: HostOpsLanePorts = {
    service: () => parts.ops ?? null,
    resourceRoot: () => machine.resourceRoot,
    unattended: new Set(),
  }
  const runtime = createHostRuntime(
    { ...machine, log, appServices: ports.appServices, headroom: ports.headroom },
    {
      leases,
      claudeAccounts: accounts,
      ...hostLivePolicy(config.path, config.config),
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
    pauseFor: (laneId) => parts.services?.pauses?.pauseFor(laneId),
  })
  const live = hosted.live
  parts.live = live
  const activeTopic = live.lanesTopic
  const routines = createHostRoutines({
    directory: hostStateDirectory(context.env, context.home),
    uid: context.uid,
    store,
    runtime,
    changed: () => activeTopic.routinesChanged(),
    now: context.now,
    paused: () => (parts.services?.pauses?.state().kind ?? 'none') !== 'none',
  })
  parts.routines = routines
  const nameLane = createLaneNamer(machine, hostLaneNaming(config, runtime, accounts))
  parts.nameLane = nameLane
  return {
    leases,
    accounts,
    runtime,
    live,
    unattached: hosted.unattached,
    routines,
    nameLane,
    opsLanes,
  }
}

type StartedRuntime = Awaited<ReturnType<typeof startRuntime>>

/** Lane commands over the runtime, with terminals, repositories and machine administration. */
function createMachineCommands(
  context: RunContext,
  parts: RunParts,
  ports: RunMachinePorts,
  machine: Omit<HostMachine, 'log'>,
  log: HostLog,
  started: StartedRuntime,
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
  const repositories = createRepositories({
    home: context.home,
    configPath: config.path,
    uid: context.uid,
    store,
    live: (id) =>
      parts.store
        ?.listLanes()
        .some((l) => l.repositoryId === id && parts.live?.sessionFor(l.laneId) !== null) ?? false,
    changed: (roots) => {
      runtime.replaceRoots(roots)
      live.lanesTopic.repositoriesChanged()
    },
  })
  const { features, ...administration } = createRunAdministration({
    context,
    configPath: config.path,
    env: machine.env,
    pi: machine.pi,
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
  return { features, commands, terminals }
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
  const machine = inspection.machine
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
  const { live, runtime, routines } = started
  const now = context.now ?? Date.now
  const pausePorts = hostLanePausePorts({
    store: ports.store,
    live,
    routines,
    runtime,
    now,
    log: log.write,
  })
  parts.services = createRunServices(
    machine.shellEnvironment,
    ports.appServices,
    ports.headroom,
    pausePorts,
  )
  const {
    features: administrationFeatures,
    commands,
    terminals,
  } = createMachineCommands(context, parts, ports, machine, log, started)
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
  await bindRunOps(context, parts, ports, { ...started, machine, log, lanes })
  routines.start()
  return { lanes, accounts: started.accounts }
}

/** Agent control over the started lane service, before routines can start a lane. */
async function bindRunOps(
  context: RunContext,
  parts: RunParts,
  ports: RunMachinePorts,
  started: StartedRuntime & { machine: Omit<HostMachine, 'log'>; log: HostLog; lanes: LaneService },
) {
  const { ops } = ports
  if (!ops) return
  const { runtime, live } = started
  parts.ops = await startRunOps({
    slot: ops.slot,
    stateDirectory: ports.stateDirectory,
    configDirectory: dirname(resolve(context.configPath)),
    uid: context.uid,
    store: ports.store,
    lanes: started.lanes,
    live,
    command: (sessionId, rpc) => runtime.command(sessionId, rpc),
    shellEnvironment: started.machine.shellEnvironment ?? null,
    enrolledId: () => ops.enrolled.current?.identity.hostId ?? null,
    remote: ops.remote,
    unattended: started.opsLanes.unattended,
    log: started.log.write,
    now: context.now,
  })
}
