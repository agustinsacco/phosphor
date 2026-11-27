import { record } from '@shared/host-protocol/primitives'
import type { OpsRunResult } from '@shared/host-protocol-ops'
import type { LocalMachineStatus } from '@shared/ipc'
import { parseMachineUpdateReport, type MachineUpdateReport } from '@shared/machine-update'
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

/** A result's identity: the version it ended on and when it finished. */
export const resultId = (last: LastUpdate): string => `${last.to}@${last.at}`

const later = (a: string | undefined, b: string | undefined) =>
  a !== undefined && (b === undefined || Date.parse(a) > Date.parse(b))

/**
 * The Host's offer across reads. A status checked later than the offer
 * replaces or clears it; one without a newer `checkedAt` (a Host that restarted
 * and has not checked yet) changes nothing. A Host with no report has none.
 */
export function nextOffer(
  offer: MachineUpdateEntry['offer'],
  report: MachineUpdateReport | undefined,
): MachineUpdateEntry['offer'] {
  if (!report?.supported) return undefined
  if (report.available) {
    if (offer?.version === report.available && !later(report.checkedAt, offer.checkedAt))
      return offer
    return {
      version: report.available,
      ...(report.checkedAt ? { checkedAt: report.checkedAt } : {}),
    }
  }
  return later(report.checkedAt, offer?.checkedAt) ? undefined : offer
}

/**
 * Accounts for the Host's `last` result once, by its identity. A run that is
 * still going, or that restarted, owns the first new result it sees; any other
 * new rollback or failed apply becomes one reported run, whatever ran before.
 */
export function observeResult(entry: MachineUpdateEntry, now: number): MachineUpdateEntry {
  const { last, run } = entry
  if (!last || resultId(last) === entry.resultSeen) return entry
  const resultSeen = resultId(last)
  if (run && !run.reported && !run.claimed && last.at !== run.before) {
    if (!run.settled || run.restartAt !== undefined)
      return { ...entry, resultSeen, run: { ...run, claimed: true } }
  }
  if (run && !run.settled) return entry
  const reported = reportedRun(entry, last, now)
  return { ...entry, resultSeen, ...(reported ? { run: reported } : {}) }
}

/** How long the updater keeps `update-result.json`, and so how long a result is news. */
const RESULT_TTL_MS = 24 * 60 * 60_000

/**
 * A rollback or failed apply the Host reports with no run here to explain it
 * (a reload mid-restart, or an update started elsewhere): one settled run,
 * shown once in the bottom-left row and the Software row.
 */
export function reportedRun(
  entry: MachineUpdateEntry,
  last: LastUpdate | undefined,
  now: number,
): UpdateRun | undefined {
  if (!last || last.outcome === 'updated' || resultId(last) === entry.resultSeen) return undefined
  const at = Date.parse(last.at)
  if (!Number.isFinite(at) || now - at >= RESULT_TTL_MS) return undefined
  return {
    path: 'op',
    started: now,
    shownAt: now,
    step: 'health',
    reached: 'health',
    from: last.from,
    to: last.to,
    before: last.at,
    finish: last.outcome === 'failed' ? 'apply' : 'rolled-back',
    settled: true,
    settledAt: now,
    reported: true,
  }
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
