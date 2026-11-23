import { join } from 'node:path'
import { piSessionsRoot } from '@phosphor/session-runtime/pi/pi-paths'
import { seedArtifactSkill } from '@phosphor/session-runtime/bundled-skills'
import { hostLivePolicy } from '../config/live-policy'
import { createRepositories } from '../features/repositories'
import { createLaneCalls } from '../lanes/calls'
import { createLaneCommands } from '../lanes/commands'
import { transcriptTrash } from '../lanes/delete'
import { createHostLiveLanes } from '../lanes/live-host'
import { createLaneNamer, hostLaneNaming } from '../lanes/naming'
import { createRuntimeLanes } from '../lanes/runtime-host'
import type { LaneService } from '../lanes/service'
import { hostStateDirectory } from '../lanes/state-dir'
import type { HostStore } from '../lanes/store'
import { createHostLog, hostLogDirectory } from '../machine/log'
import type { HostClaudeAccounts } from '../providers/accounts'
import { createHostRoutines, routineOwnership } from '../routines/service'
import { createHostRuntime, type HostMachine } from '../session/runtime'
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

/** What the machine needs from the rest of run: state it opened, and the control link's ports. */
export interface RunMachinePorts {
  epoch: string
  config: RunConfig
  stateDirectory: string
  store: HostStore
  sink: ReceiptSink
  webPush: StartWebPush
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
  const runtime = createHostRuntime(
    { ...machine, log },
    {
      claudeAccounts: accounts,
      ...hostLivePolicy(config.path, config.config),
      dialogs: 'forward',
      trashTranscript: trash.move,
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
  })
  parts.routines = routines
  const nameLane = createLaneNamer(machine, hostLaneNaming(config, runtime, accounts))
  parts.nameLane = nameLane
  return { accounts, runtime, live, unattached: hosted.unattached, routines, nameLane }
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
    repositories,
    attachments: parts.attachments,
    terminals,
    store,
    ...binding,
    runtime: binding,
    routines,
    sessionFor: live.sessionFor,
    openDialogs: live.openDialogs,
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
  const started = await startRuntime(context, parts, ports, machine, log)
  parts.services = createRunServices(machine.shellEnvironment)
  const { live, runtime, routines } = started
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
  routines.start()
  return { lanes, accounts: started.accounts }
}
