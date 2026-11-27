import type { HostConnectionView, LocalMachineStatus } from '@shared/ipc'
import type { ServicePauseState } from '@shared/host-protocol-owner'
import type { MachineUpdateReport } from '@shared/machine-update'
import { compareVersions } from '@shared/version'
import {
  RESTART_DEADLINE_MS,
  RESTART_SLOW_MS,
  restartedFor,
  waitEnded,
} from './machineUpdateTimers'

export type UpdateStep = 'downloading' | 'waiting' | 'paused' | 'restarting' | 'health'
export const UPDATE_STEPS: readonly UpdateStep[] = [
  'downloading',
  'waiting',
  'paused',
  'restarting',
  'health',
]
export type MachineUpdatePhase =
  'unknown' | 'current' | 'available' | UpdateStep | 'done' | 'failed'
export type UpdatePath = 'op' | 'task'
export type UpdateFinish =
  | 'updated'
  | 'current'
  | 'rolled-back'
  /** A new instance came back on the old version with no update result: not proof of a rollback. */
  | 'restarted'
  | 'download'
  | 'still-working'
  | 'cancelled'
  | 'refused'
  | 'not-back'
  | 'apply'
export type LastUpdate = NonNullable<LocalMachineStatus['lastUpdate']>
export type Waiting = Extract<ServicePauseState, { kind: 'pausing' }>
export interface UpdateStatus {
  pause: ServicePauseState
  pauseControl?: true
  /** The Host's own report (tier 2); absent from an older Host. */
  update?: MachineUpdateReport
}
export interface UpdateRun {
  path: UpdatePath
  started: number
  from?: string
  to?: string
  epoch?: string
  before?: string
  step: UpdateStep
  shownAt: number
  reached: UpdateStep
  waiting?: Waiting
  /** When this client first saw the wait for working lanes. */
  waitingSince?: number
  interruptedLink?: 'offline' | 'returned'
  restartAt?: number
  /** Restarting past `RESTART_SLOW_MS`: a failed update may be rolling back. */
  slowRestart?: true
  wentOffline?: true
  finish?: UpdateFinish
  settled?: true
  settledAt?: number
  /** Its Settings row was shown, so the bottom-left row lets a failure go. */
  seen?: true
  /** Not a run this client tracked: the Host's `last` result, shown once. */
  reported?: true
  /** This run owns the first new `last` result it saw. */
  claimed?: true
  jobId?: string
  awaitingJob?: true
  taskExit?: { code: number; at: number }
  details?: string
  controlling?: 'abort-now' | 'cancel'
}
export interface MachineUpdateEntry {
  version?: string
  status?: UpdateStatus
  last?: LastUpdate
  run?: UpdateRun
  /** The connection the last status read was on: an offer stays until a read on a new one. */
  readToken?: string
  /** The Host's offer, kept until a status checked later says otherwise. */
  offer?: { version: string; checkedAt?: string }
  /** The last `last` result this client has accounted for (`resultId`). */
  resultSeen?: string
  /** When the machine became ready, and last left ready; the shell's observer keeps them. */
  readySince?: number
  downSince?: number
  /** Away 10 minutes: the offer is no longer news until a fresh status read. */
  offerExpired?: true
}

/** How long an offer outlives a disconnection. */
export const OFFER_STALE_MS = 10 * 60_000

/** "Updated to X" holds this long before anything else, a newer offer included. */
export const UPDATED_RESULT_MS = 8000

/** One machine's readiness, from its connection. */
export function trackReady(
  entry: MachineUpdateEntry,
  host: HostConnectionView | undefined,
  now: number,
): MachineUpdateEntry {
  const ready = host?.state === 'ready'
  if (
    !entry.offerExpired &&
    entry.readySince === undefined &&
    entry.downSince !== undefined &&
    now - entry.downSince >= OFFER_STALE_MS
  )
    return trackReady({ ...entry, offerExpired: true }, host, now)
  // `downSince` stays: how long it was away decides whether its offer outlived the gap.
  if (ready && entry.readySince === undefined) return { ...entry, readySince: now }
  if (!ready && entry.readySince !== undefined)
    return { ...entry, readySince: undefined, downSince: now }
  return entry
}

export function nextRun(run: UpdateRun, now: number): UpdateRun {
  if (run.settled || now - run.shownAt < 600) return run
  const at = UPDATE_STEPS.indexOf(run.step)
  const reached = UPDATE_STEPS.indexOf(run.reached)
  // A run that restarted walks its steps to the result, as a successful one does.
  const walks =
    run.finish === 'updated' || run.finish === 'rolled-back' || run.finish === 'restarted'
  if (run.finish && (at >= reached || !walks)) return { ...run, settled: true, settledAt: now }
  if (at >= reached) return run
  const next = UPDATE_STEPS[at + 1]!
  const step =
    next === 'waiting' && (!run.waiting || run.path === 'task') ? UPDATE_STEPS[at + 2]! : next
  return { ...run, step, shownAt: now }
}

export function startRun(
  path: UpdatePath,
  entry: MachineUpdateEntry,
  host: HostConnectionView | undefined,
  now: number,
): UpdateRun {
  return {
    path,
    started: now,
    shownAt: now,
    step: 'downloading',
    reached: 'downloading',
    from: host?.hostVersion ?? entry.version,
    before: entry.last?.at,
    epoch: host?.cursor?.epoch,
  }
}

export function reach(run: UpdateRun, step: UpdateStep, now: number): UpdateRun {
  if (UPDATE_STEPS.indexOf(step) <= UPDATE_STEPS.indexOf(run.reached)) return run
  return {
    ...run,
    reached: step,
    restartAt: run.restartAt ?? (step === 'restarting' || step === 'health' ? now : undefined),
  }
}

/** Only a Host pause advances waiting/paused; lost or stale reads never undo one. */
export function observePause(
  run: UpdateRun,
  pause: ServicePauseState | undefined,
  now: number,
): UpdateRun {
  if (run.finish || run.path !== 'op') return run
  if (pause?.kind === 'pausing' && !run.restartAt && run.reached !== 'paused')
    return { ...reach(run, 'waiting', now), waiting: pause, waitingSince: run.waitingSince ?? now }
  if (pause?.kind === 'paused') return reach(run, 'paused', now)
  // An externally started pause has no job for this principal; its deadline is still authoritative.
  if (
    pause?.kind === 'none' &&
    !run.jobId &&
    !run.awaitingJob &&
    !run.controlling &&
    run.reached === 'waiting'
  )
    return { ...run, finish: pause.ended === 'cancelled' ? 'cancelled' : 'still-working' }
  return run
}

function returned(
  run: UpdateRun,
  entry: MachineUpdateEntry,
  host: HostConnectionView,
  now: number,
): UpdateRun {
  const version = host.hostVersion ?? entry.version
  const last =
    entry.last?.at !== run.before && entry.last?.from === run.from ? entry.last : undefined
  if (version && run.from && version !== run.from)
    return { ...reach(run, 'health', now), finish: 'updated', settled: undefined, to: version }
  if (last?.outcome === 'rolled-back' || last?.outcome === 'failed')
    return {
      ...reach(run, 'health', now),
      finish: last.outcome === 'failed' ? 'apply' : 'rolled-back',
      settled: undefined,
      to: last.to,
    }
  // The lanes snapshot can reveal a new runtime epoch after the transport is ready.
  const epoch = host.cursor?.epoch
  if (
    (run.interruptedLink || run.restartAt !== undefined) &&
    run.epoch &&
    epoch &&
    epoch !== run.epoch
  )
    return { ...reach(run, 'health', now), finish: 'restarted', settled: undefined }
  if (
    !run.wentOffline &&
    version &&
    version === run.from &&
    restartedFor(run, now, RESTART_SLOW_MS)
  )
    return { ...run, finish: 'apply' }
  return run
}

export function observeConnection(
  run: UpdateRun,
  entry: MachineUpdateEntry,
  host: HostConnectionView | undefined,
  now: number,
): UpdateRun {
  if (run.finish && run.finish !== 'not-back') return run
  if (host?.state === 'ready')
    return returned(
      run.interruptedLink === 'offline' ? { ...run, interruptedLink: 'returned' } : run,
      entry,
      host,
      now,
    )
  if (run.path === 'task' || run.restartAt !== undefined)
    return run.wentOffline ? run : { ...reach(run, 'restarting', now), wentOffline: true }
  // A fast update can drop the link before either poll sees the handoff, but so can a blip.
  const pause = entry.status?.pause.kind
  if (run.jobId || run.reached === 'paused' || pause === 'pausing' || pause === 'paused')
    return run.interruptedLink === 'offline' ? run : { ...run, interruptedLink: 'offline' }
  return run
}

export function tickRun(run: UpdateRun, now: number): UpdateRun {
  if (!run.finish) {
    if (
      run.taskExit &&
      !run.wentOffline &&
      now - run.taskExit.at >= 4000 &&
      run.taskExit.code !== 0
    )
      return nextRun({ ...run, finish: 'download' }, now)
    if (restartedFor(run, now, RESTART_DEADLINE_MS))
      return nextRun({ ...run, finish: 'not-back' }, now)
    if (waitEnded(run, now)) return nextRun({ ...run, finish: 'still-working' }, now)
    if (!run.slowRestart && restartedFor(run, now, RESTART_SLOW_MS))
      return nextRun({ ...run, slowRestart: true }, now)
    if (run.reached === 'paused' && now - run.shownAt >= 5 * 60_000)
      return nextRun({ ...run, finish: 'apply' }, now)
    if (run.reached === 'downloading' && now - run.started >= 15 * 60_000)
      return nextRun({ ...run, finish: 'download' }, now)
  }
  return nextRun(run, now)
}

export function holdUpdatePage(run: UpdateRun | undefined): boolean {
  return (
    !!run &&
    (run.finish === 'not-back' ||
      (!run.settled &&
        (run.interruptedLink === 'offline' ||
          run.reached === 'paused' ||
          run.restartAt !== undefined)))
  )
}

/** A newer offer replaces a settled run once its result has nothing left to say. */
function offerOutranks(run: UpdateRun | undefined, available: string, now: number): boolean {
  if (!run) return true
  if (!run.settled) return false
  if (run.finish === 'updated')
    return (
      now - (run.settledAt ?? -Infinity) >= UPDATED_RESULT_MS &&
      (!run.to || compareVersions(available, run.to) > 0)
    )
  if (run.finish === 'current' || run.finish === 'cancelled') return true
  return !!run.seen && run.finish !== 'not-back'
}

/** The Host's own report wins (tier 2); an older Host only learns of a newer version elsewhere. */
function newerRelease(
  installed: string | undefined,
  entry: MachineUpdateEntry,
  peers: Iterable<HostConnectionView>,
): { available?: string; availableFrom?: 'host' | 'peer' } {
  if (!installed) return {}
  const report = entry.status?.update
  if (report) {
    const offered = entry.offer?.version ?? report.available
    return offered && compareVersions(offered, installed) > 0
      ? { available: offered, availableFrom: 'host' }
      : {}
  }
  let available: string | undefined
  for (const peer of peers) {
    const version = peer.hostVersion
    if (version && compareVersions(version, available ?? installed) > 0) available = version
  }
  return available ? { available, availableFrom: 'peer' } : {}
}

export function deriveMachineUpdate(input: {
  machineId: string
  label: string
  host?: HostConnectionView
  entry: MachineUpdateEntry
  peers: Iterable<HostConnectionView>
  configure: boolean
  terminal: boolean
  owner: boolean
  now?: number
}) {
  const { machineId, label, host, entry, peers, configure, terminal, owner } = input
  const now = input.now ?? Date.now()
  const { run } = entry
  const ready = host?.state === 'ready'
  const installed = (ready ? host.hostVersion : undefined) ?? entry.version
  const { available, availableFrom } = newerRelease(installed, entry, peers)
  const path: UpdatePath | 'none' = host?.ops
    ? 'op'
    : host?.capabilities.includes('terminal') && terminal
      ? 'task'
      : 'none'
  const start = !!(
    ready &&
    configure &&
    (path === 'task' || (path === 'op' && host.capabilities.includes('sessions.control')))
  )
  const control = !!(
    ready &&
    configure &&
    run?.step === 'waiting' &&
    !run.finish &&
    entry.status?.pause.kind === 'pausing' &&
    !run.controlling &&
    (owner || entry.status.pauseControl)
  )
  const phase: MachineUpdatePhase =
    run && !run.settled
      ? run.step
      : available && offerOutranks(run, available, now)
        ? 'available'
        : run?.finish === 'updated'
          ? 'done'
          : run?.finish && run.finish !== 'current' && run.finish !== 'cancelled'
            ? 'failed'
            : installed || ready
              ? 'current'
              : 'unknown'
  return {
    machineId,
    label,
    product: host?.local ? ('service' as const) : ('host' as const),
    phase,
    path,
    installed,
    available,
    availableFrom,
    checkedAt: entry.status?.update?.checkedAt,
    waitingOn: run?.waiting?.waitingOn,
    deadline: run?.waiting?.deadline,
    from: run?.from,
    to: run?.to,
    run,
    can: {
      start: start && (!run || !!run.settled) && run?.finish !== 'not-back',
      why: !ready
        ? 'Connect to check for an update.'
        : !configure
          ? 'Needs configuration access.'
          : !start
            ? 'This connection cannot update the service.'
            : undefined,
      stopTurns: control,
      cancel: control,
    },
  }
}
export type MachineUpdateState = ReturnType<typeof deriveMachineUpdate>
