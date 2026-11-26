import type { HostConnectionView, LocalMachineStatus } from '@shared/ipc'
import type { ServicePauseState } from '@shared/host-protocol-owner'
import { compareVersions } from '@shared/version'

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
  restartAt?: number
  wentOffline?: true
  finish?: UpdateFinish
  settled?: true
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
}

export function nextRun(run: UpdateRun, now: number): UpdateRun {
  if (run.settled || now - run.shownAt < 600) return run
  const at = UPDATE_STEPS.indexOf(run.step)
  const reached = UPDATE_STEPS.indexOf(run.reached)
  if (run.finish && (at >= reached || (run.finish !== 'updated' && run.finish !== 'rolled-back')))
    return { ...run, settled: true }
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
    return { ...reach(run, 'waiting', now), waiting: pause }
  if (pause?.kind === 'paused') return reach(run, 'paused', now)
  // An externally started pause has no job for this principal; its deadline is still authoritative.
  if (
    pause?.kind === 'none' &&
    !run.jobId &&
    !run.awaitingJob &&
    !run.controlling &&
    run.reached === 'waiting'
  )
    return { ...run, finish: 'still-working' }
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
  // A live transport can reconnect to the same daemon; only a new runtime epoch implies restart.
  if (run.wentOffline && run.epoch && host.cursor?.epoch && host.cursor.epoch !== run.epoch)
    return { ...reach(run, 'health', now), finish: 'rolled-back', settled: undefined }
  return run
}

export function observeConnection(
  run: UpdateRun,
  entry: MachineUpdateEntry,
  host: HostConnectionView | undefined,
  now: number,
): UpdateRun {
  if (run.finish && run.finish !== 'not-back') return run
  if (host?.state === 'ready') return returned(run, entry, host, now)
  if (run.reached === 'paused' || run.path === 'task' || run.restartAt)
    return run.wentOffline ? run : { ...reach(run, 'restarting', now), wentOffline: true }
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
    if (run.restartAt !== undefined && now - run.restartAt >= 4 * 60_000)
      return nextRun({ ...run, finish: 'not-back' }, now)
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
      (!run.settled && (run.reached === 'paused' || run.restartAt !== undefined)))
  )
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
}) {
  const { machineId, label, host, entry, peers, configure, terminal, owner } = input
  const { run } = entry
  const ready = host?.state === 'ready'
  const installed = (ready ? host.hostVersion : undefined) ?? entry.version
  let available: string | undefined
  if (installed)
    for (const peer of peers) {
      const version = peer.hostVersion
      if (version && compareVersions(version, available ?? installed) > 0) available = version
    }
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
      : run?.finish === 'updated'
        ? 'done'
        : run?.finish && run.finish !== 'current' && run.finish !== 'cancelled'
          ? 'failed'
          : available && !run
            ? 'available'
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
    availableFrom: available ? ('peer' as const) : undefined,
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
