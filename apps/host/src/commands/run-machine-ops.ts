import { dirname, resolve } from 'node:path'
import { isWithinFolder } from '@phosphor/shared/paths'
import { piSessionsRoot } from '@phosphor/session-runtime/pi/pi-paths'
import { createHostSandboxes } from '../features/sandboxes'
import { ownerTrash } from '../lanes/delete-target'
import { transcriptTrash } from '../lanes/delete'
import type { createRuntimeLanes } from '../lanes/runtime-host'
import type { LaneService } from '../lanes/service'
import type { HostMachine } from '../session/runtime'
import { daemonLanePorts } from '../ops/lane-ports'
import { startRunOps } from '../ops/service'
import type { RunContext } from './run'
import type { createRunAdministration } from './run-administration'
import type { createMachineCommands, HostLog, RunMachinePorts, StartedRuntime } from './run-machine'
import type { RunParts } from './run-teardown'

/** Owner-authorized lane maintenance uses the same archive, stop, resume and delete services. */
export function laneManagement(
  administration: Pick<ReturnType<typeof createRunAdministration>, 'archives' | 'deleteLane'>,
  binding: ReturnType<typeof createRuntimeLanes>,
  parts: RunParts,
) {
  return {
    archives: administration.archives,
    deleteLane: administration.deleteLane,
    stopLane: binding.stopLane,
    resumeLane: binding.resumeLane,
    admitsResume(id: string) {
      const pauses = parts.services?.pauses
      const op = { type: 'lane.resume' } as const
      if (pauses?.admits(op) === false) return false
      pauses?.continued(id, op)
      return true
    },
  }
}

/** P2's sandboxes over the started lanes; their records share the folder service's queue. */
function runSandboxes(
  context: RunContext,
  ports: RunMachinePorts,
  started: StartedRuntime & Pick<ReturnType<typeof createMachineCommands>, 'resources'>,
) {
  const { runtime, live } = started
  return createHostSandboxes({
    ...context,
    local: !!ports.local,
    configPath: ports.config.path,
    stateDirectory: ports.stateDirectory,
    store: ports.store,
    leases: started.leases,
    live: (path) => runtime.list().some((s) => isWithinFolder(s.workspacePath, path)),
    trashItem: (file, owner) =>
      (
        ownerTrash(!!ports.local && owner, context.platform, context.trashRunner) ??
        transcriptTrash(ports.stateDirectory).move
      )(file),
    changed: (roots) => {
      runtime.replaceRoots(roots)
      live.lanesTopic.repositoriesChanged()
    },
    serialize: (work) => started.resources.repositories.serialize(work),
  })
}

/** Agent control over the started lane service, before routines can start a lane. */
export async function bindRunOps(
  context: RunContext,
  parts: RunParts,
  ports: RunMachinePorts,
  started: StartedRuntime &
    Pick<
      ReturnType<typeof createMachineCommands>,
      'management' | 'settingsOps' | 'resources' | 'laneCommand' | 'writes'
    > & {
      machine: Omit<HostMachine, 'log'>
      log: HostLog
      lanes: LaneService
    },
) {
  const { ops } = ports
  if (!ops) return
  const { runtime, live } = started
  parts.ops = await startRunOps({
    ...started.resources,
    appServices: parts.services?.appServices,
    sandboxes: runSandboxes(context, ports, started),
    ...daemonLanePorts({
      runtime,
      laneCommand: started.laneCommand,
      live,
      endings: started.opsLanes.endings,
      pauses: () => parts.services?.pauses,
      env: started.machine.env,
      home: context.home,
      platform: context.platform,
      log: started.log.write,
    }),
    ...(started.writes ? { writes: started.writes } : {}),
    slot: ops.slot,
    stateDirectory: ports.stateDirectory,
    configDirectory: dirname(resolve(context.configPath)),
    uid: context.uid,
    store: ports.store,
    lanes: started.lanes,
    management: started.management,
    settingsOps: { ...started.settingsOps, headroom: ports.headroom?.handlers },
    live,
    command: started.laneCommand,
    shellEnvironment: started.machine.shellEnvironment ?? null,
    editing: {
      runtime,
      sessionsRoot: piSessionsRoot(context.env, context.home),
      announce: (laneId) => {
        const summary = live.summaryFor(laneId)
        if (summary) live.lanesTopic.delta([summary])
      },
    },
    enrolledId: () => ops.enrolled.current?.identity.hostId ?? null,
    remote: ops.remote,
    directory: ops.directory,
    unattended: started.opsLanes.unattended,
    log: started.log.write,
    now: context.now,
  })
}
