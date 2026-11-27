import { record } from '@shared/host-protocol/primitives'
import type { OpsRunResult } from '@shared/host-protocol-ops'
import type { LocalMachineStatus } from '@shared/ipc'
import { parseMachineUpdateReport } from '@shared/machine-update'
import type { LastUpdate, MachineUpdateEntry, UpdateStatus, UpdateRun } from './machineUpdateState'
import { reach } from './machineUpdateState'

const count = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0

export function readUpdateStatus(value: unknown): UpdateStatus | undefined {
  if (!record(value) || !record(value.pause)) return undefined
  const pause = value.pause
  const support = record(value.update) && value.update.pauseControl === true
  const report = parseMachineUpdateReport(value.update)
  const flags = {
    ...(support ? { pauseControl: true as const } : {}),
    ...(report ? { update: report } : {}),
  }
  if (pause.kind === 'none') return { pause: { kind: 'none' }, ...flags }
  if (pause.purpose !== 'update' || typeof pause.since !== 'string') return undefined
  const base = { purpose: 'update' as const, since: pause.since }
  if (pause.kind === 'paused') return { pause: { kind: 'paused', ...base }, ...flags }
  if (pause.kind !== 'pausing' || typeof pause.deadline !== 'string' || !record(pause.waitingOn))
    return undefined
  const { turns, subagents, routines } = pause.waitingOn
  if (!count(turns) || !count(subagents) || !count(routines)) return undefined
  return {
    pause: {
      ...base,
      kind: 'pausing',
      deadline: pause.deadline,
      waitingOn: { turns, subagents, routines },
    },
    ...flags,
  }
}

/**
 * The last update's result: the owner socket's on This Mac, else the Host's
 * own report. A read without a report (an older Host) keeps what is known.
 */
export function lastUpdateOf(
  entry: MachineUpdateEntry,
  status: UpdateStatus | undefined,
  local?: Pick<LocalMachineStatus, 'lastUpdate'>,
): LastUpdate | undefined {
  if (local?.lastUpdate === null) return undefined
  if (local?.lastUpdate) return local.lastUpdate
  return status?.update ? status.update.last : entry.last
}

export function appendUpdateDetails(run: UpdateRun, text: string): UpdateRun {
  return { ...run, details: ((run.details ? `${run.details}\n` : '') + text).slice(-32_000) }
}

export function readUpdateJob(run: UpdateRun, answer: OpsRunResult, now: number): UpdateRun {
  if (run.finish || answer.status !== 'ok' || !record(answer.data)) return run
  const job = answer.data
  if (job.op !== 'service.update' || !record(job.result)) return run
  const out = typeof job.result.text === 'string' ? appendUpdateDetails(run, job.result.text) : run
  const result = record(job.result.data) ? job.result.data : {}
  const to = typeof result.version === 'string' ? result.version : run.to
  if (job.state === 'failed') {
    const reason = typeof job.result.text === 'string' ? job.result.text : ''
    return {
      ...out,
      finish: reason.includes('not installed from a release')
        ? 'refused'
        : run.reached === 'paused' || reason.startsWith('Applying ')
          ? 'apply'
          : 'download',
    }
  }
  if (job.state !== 'done') return run
  if (result.outcome === 'current') return { ...out, finish: 'current' }
  if (result.outcome === 'not-paused')
    return { ...out, to, finish: result.pause === 'cancelled' ? 'cancelled' : 'still-working' }
  if (result.outcome === 'applying')
    return { ...reach(out, 'restarting', now), jobId: undefined, to }
  return run
}
