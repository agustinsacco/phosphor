import { createWorkspaceLeases } from '../owner/lease'
import { isRoutineSession } from '@phosphor/session-runtime/routines/ownership'
import { join } from 'node:path'
import { piSessionsRoot } from '@phosphor/session-runtime/pi/pi-paths'
import { seedArtifactSkill } from '@phosphor/session-runtime/bundled-skills'
import { hostLivePolicy } from '../config/live-policy'
import { ownerTrash } from '../lanes/delete-target'
import { transcriptTrash } from '../lanes/delete'
import { createHostLiveLanes } from '../lanes/live-host'
import { createLaneNamer, hostLaneNaming } from '../lanes/naming'
import { hostStateDirectory } from '@phosphor/shared/host-local'
import { createHostRoutines, routineOwnership } from '../routines/service'
import { createRunEndings } from '../ops/lane-reload'
import type { HostOpsLanePorts } from '../session/contributions/ops'
import type { HostStore } from '../lanes/store'
import type { HostClaudeAccounts } from '../providers/accounts'
import { createHostRuntime, type HostMachine } from '../session/runtime'
import { qualifiedRunBrain } from '../brain/run'
import type { RunContext } from './run'
import { createRunAccounts } from './run-administration'
import type { HostLog, RunMachinePorts } from './run-machine'
import type { RunParts } from './run-teardown'

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

function startRoutines(
  context: RunContext,
  parts: RunParts,
  { store, machine }: { store: HostStore; machine: Omit<HostMachine, 'log'> },
  runtime: ReturnType<typeof createHostRuntime>,
  live: ReturnType<typeof createHostLiveLanes>['live'],
) {
  return createHostRoutines({
    directory: hostStateDirectory(context.env, context.home),
    uid: context.uid,
    store,
    runtime,
    checkPi() {
      if (!machine.pi) throw new Error('pi is unavailable.')
    },
    promotion: {
      sessionsRoot: piSessionsRoot(context.env, context.home),
      adopt: (input) => store.ensureLane(input),
      publish: (id) => {
        const summary = live.summaryFor(id)
        if (summary) live.lanesTopic.delta([summary])
      },
    },
    changed: live.lanesTopic.routinesChanged,
    resourceChanged: live.lanesTopic.resourceChanged,
    now: context.now,
    paused: () => (parts.services?.pauses?.state().kind ?? 'none') !== 'none',
  })
}

/**
 * The runtime's machine, with the Host's Brain for its lanes' recall. Only a qualified bundle
 * has a Brain, and a fresh Host's stays off and creates nothing.
 */
function runtimeMachine(
  context: RunContext,
  parts: RunParts,
  ports: RunMachinePorts,
  machine: HostMachine,
  accounts: HostClaudeAccounts,
): HostMachine {
  parts.brain = qualifiedRunBrain(machine.resourceRoot, {
    ...ports.brain,
    stateDirectory: ports.stateDirectory,
    pi: machine.pi,
    env: machine.env,
    accounts,
    store: ports.store,
    sessionsRoot: piSessionsRoot(context.env, context.home),
    busy: (path) => parts.runtime?.sessionFileBusy(path),
    runtime: () => parts.runtime,
    local: ports.local,
    install: context,
    log: (message, data) => machine.log.write('brain', message, data),
  })
  return {
    ...machine,
    appServices: ports.appServices,
    ...(parts.brain ? { brainRecall: parts.brain.recall, brainCurator: parts.brain.curator } : {}),
    headroom: ports.headroom,
  }
}

/** The runtime and what owns its lanes: live lanes, routines and the lane namer. */
export async function startRuntime(
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
    runtimeMachine(context, parts, ports, { ...machine, log }, accounts),
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
  const routines = startRoutines(context, parts, { store, machine }, runtime, live)
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
