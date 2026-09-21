import { DateTime } from 'luxon'
import type { RoutineRun } from '@shared/routines'

/**
 * A run's place on the calendar is the viewer's own day, not the routine's.
 *
 * Runs from routines pinned to different timezones share one Activity list, so
 * grouping by each run's saved zone would interleave days. Individual rows
 * still print their times in the routine's zone, which is where the schedule
 * lives; only the heading is local.
 */
export function runDayAt(run: RoutineRun): number {
  return run.startedAt ?? run.scheduledAt
}

export interface RunDay {
  /** Local ISO date, stable across renders and usable as a React key. */
  key: string
  label: string
  runs: RoutineRun[]
}

/** Newest day first, newest run first inside each day. */
export function groupRunsByDay(runs: RoutineRun[], now: number = Date.now()): RunDay[] {
  const today = DateTime.fromMillis(now).startOf('day')
  const days = new Map<string, RoutineRun[]>()
  for (const run of [...runs].sort((a, b) => runDayAt(b) - runDayAt(a))) {
    const key = DateTime.fromMillis(runDayAt(run)).toISODate() ?? 'unknown'
    const list = days.get(key)
    if (list) list.push(run)
    else days.set(key, [run])
  }
  return [...days].map(([key, list]) => {
    const date = DateTime.fromISO(key)
    const distance = today.diff(date, 'days').days
    return {
      key,
      label:
        distance === 0
          ? 'Today'
          : distance === 1
            ? 'Yesterday'
            : date.toFormat(distance < 365 ? 'cccc, dd LLLL' : 'dd LLLL yyyy'),
      runs: list,
    }
  })
}

export interface ActivityFilter {
  routineId: string | null
  workspacePath: string | null
  trigger: 'all' | 'scheduled' | 'one-off'
  failedOnly: boolean
}

export const ALL_RUNS: ActivityFilter = Object.freeze({
  routineId: null,
  workspacePath: null,
  trigger: 'all',
  failedOnly: false,
})

/**
 * A one-off is a trigger, not an entity: Run now, or a routine whose whole
 * schedule is a single absolute time. Everything else recurs.
 */
export function isOneOff(run: RoutineRun): boolean {
  return run.trigger === 'manual' || run.definition.schedule.kind !== 'cron'
}

/** Anything that did not produce a result the routine could stand behind. */
export function isFailure(run: RoutineRun): boolean {
  return run.status !== 'queued' && run.status !== 'running' && run.status !== 'finished'
}

/** The workspace a run actually used, which an isolated run decides at start. */
export function runWorkspace(run: RoutineRun): string {
  return run.workspacePath ?? run.definition.workspacePath
}

export function filterRuns(runs: RoutineRun[], filter: ActivityFilter): RoutineRun[] {
  return runs.filter(
    (run) =>
      (filter.routineId === null || run.routineId === filter.routineId) &&
      (filter.workspacePath === null || runWorkspace(run) === filter.workspacePath) &&
      (filter.trigger === 'all' || isOneOff(run) === (filter.trigger === 'one-off')) &&
      (!filter.failedOnly || isFailure(run)),
  )
}
