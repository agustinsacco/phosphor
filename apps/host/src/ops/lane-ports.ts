import type { LaneEvent, LaneSummary } from '@phosphor/shared/host-protocol'
import type { RuntimeLog } from '@phosphor/session-runtime/file-log'
import { answerPauseCall, type LanePauses } from '../lanes/pause'
import type { HostRuntime } from '../session/runtime'
import { fetchSignedRelease } from '@phosphor/session-runtime/host-install/fetch'
import { startReleaseCheck } from '../update/check'
import { hostUpdateProgram } from '../update/handoff'
import { readUpdateResult } from '../update/health'
import { HOST_VERSION } from '../version'
import type { DeferredActions } from './binding'
import type { DaemonHandlerDeps } from './handlers'
import { laneReloadAction, type RunEndings } from './lane-reload'
import { updaterSteps } from './service-update'

export interface DaemonLanePortsInput {
  readonly runtime: Pick<HostRuntime, 'mcpControl' | 'reloadNow'>
  /** The lane runtime's command (`createRuntimeLanes`): naming and the model switch apply. */
  readonly laneCommand: NonNullable<DaemonHandlerDeps['laneRuntime']>['command']
  readonly live: {
    summaryFor(laneId: string): LaneSummary | null
    publish(laneId: string, event: LaneEvent): void
  }
  readonly endings: Pick<RunEndings, 'take'>
  /** Read per use: the pause starts beside the lanes. */
  readonly pauses: () => LanePauses | null | undefined
  /** The updater environment's base: pi's environment. */
  readonly env: Record<string, string>
  readonly home: string
  readonly platform: NodeJS.Platform
  /** Where the updater keeps `update-result.json`. */
  readonly stateDirectory: string
  readonly uid: number | undefined
  readonly log: RuntimeLog
}

/** `machine.status`'s update report: a source install never checks, a release checks itself. */
function machineUpdate(
  input: DaemonLanePortsInput,
  supported: boolean,
): NonNullable<DaemonHandlerDeps['machineUpdate']> {
  const check = supported
    ? startReleaseCheck({
        installed: HOST_VERSION,
        latest: async (signal) =>
          (
            await fetchSignedRelease(
              { env: input.env, platform: input.platform },
              undefined,
              HOST_VERSION,
              signal,
            )
          ).version,
        log: input.log,
      })
    : undefined
  return {
    report() {
      const last = readUpdateResult(input.stateDirectory, input.uid, Date.now())
      return { supported, ...check?.report(), ...(last ? { last } : {}) }
    },
    stop: () => check?.stop(),
  }
}

/** What agent control's lane, machine and reload ops need from the started machine. */
export function daemonLanePorts(input: DaemonLanePortsInput): Pick<
  DaemonHandlerDeps,
  'laneRuntime' | 'serviceUpdate' | 'pauseState' | 'pauseControl'
> & {
  readonly deferredActions: DeferredActions
  readonly machineUpdate: NonNullable<DaemonHandlerDeps['machineUpdate']>
} {
  const { live, runtime, pauses } = input
  const program = hostUpdateProgram(input.home, input.env, input.platform)
  const pausePorts: NonNullable<DaemonHandlerDeps['serviceUpdate']>['pauses'] = {
    begin: (purpose, deadlineMs) => {
      const current = pauses()
      if (!current) throw new Error('This Phosphor service cannot pause its lanes.')
      return current.begin(purpose, deadlineMs)
    },
    cancel: () => pauses()?.cancel(),
  }
  return {
    laneRuntime: {
      command: input.laneCommand,
      mcpControl: (sessionId, name, operation) => runtime.mcpControl(sessionId, name, operation),
      summaryFor: (laneId) => live.summaryFor(laneId),
      publishSummary(laneId) {
        const summary = live.summaryFor(laneId)
        if (summary) live.publish(laneId, { kind: 'summary', summary })
      },
    },
    ...(program
      ? {
          serviceUpdate: {
            steps: updaterSteps({ ...program, env: { ...input.env, ...program.env } }),
            pauses: pausePorts,
          },
        }
      : {}),
    machineUpdate: machineUpdate(input, program !== null),
    pauseState: () => pauses()?.state() ?? { kind: 'none' },
    pauseControl: (action) => {
      const current = pauses()
      if (!current || current.state().kind !== 'pausing') return false
      answerPauseCall(current, { action }, (event, fields) => input.log('host', event, fields))
      return true
    },
    deferredActions: {
      reload: laneReloadAction({
        reloadNow: (sessionId) => runtime.reloadNow(sessionId),
        endings: input.endings,
        prompt: (sessionId, message) => input.laneCommand(sessionId, { type: 'prompt', message }),
        admitsPrompt: () => pauses()?.admits({ type: 'prompt' }) ?? true,
        log: input.log,
      }),
    },
  }
}
