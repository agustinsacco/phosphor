import { CronExpressionParser } from 'cron-parser'
import { DateTime } from 'luxon'

export type RoutineSchedule =
  { kind: 'manual' } | { kind: 'once'; at: number } | { kind: 'cron'; expression: string }

export interface RoutineInput {
  name: string
  instructions: string
  workspacePath: string
  isolated: boolean
  intent: 'report' | 'code'
  provider: string
  model: string
  timezone: string
  schedule: RoutineSchedule
  period: 'none' | 'previous-day' | 'previous-week'
  catchUpHours: number
  maxRuntimeMinutes: number
  enabled: boolean
  trusted: boolean
}

export interface Routine extends RoutineInput {
  id: string
  revision: number
  createdAt: number
  updatedAt: number
  nextAt: number | null
  attention: string | null
  archived: boolean
}

export type RoutineRunStatus =
  | 'queued'
  | 'running'
  | 'finished'
  | 'failed'
  | 'blocked'
  | 'interrupted'
  | 'cancelled'
  | 'timed-out'
  | 'skipped'

export interface RoutineRun {
  id: string
  routineId: string
  trigger: 'schedule' | 'manual'
  scheduledAt: number
  createdAt: number
  startedAt: number | null
  endedAt: number | null
  status: RoutineRunStatus
  reason: string
  /** Immutable configuration for this occurrence, even if the routine is edited. */
  definition: Routine
  sessionId: string | null
  sessionPath: string | null
  workspacePath: string | null
  branch: string | null
  baseCommit: string | null
  accountId: string | null
  summary: string
}

export interface RoutinesSnapshot {
  routines: Routine[]
  runs: RoutineRun[]
  background: boolean
  error: string | null
}

export const RUN_LABELS: Record<RoutineRunStatus, string> = {
  queued: 'Queued',
  running: 'Running',
  finished: 'Finished · unverified',
  failed: 'Failed',
  blocked: 'Needs attention',
  interrupted: 'Interrupted',
  cancelled: 'Cancelled',
  'timed-out': 'Timed out',
  skipped: 'Skipped',
}

export function activeRun(run: RoutineRun): boolean {
  return run.status === 'queued' || run.status === 'running'
}

export function newRoutine(workspacePath: string): RoutineInput {
  return {
    name: '',
    instructions: '',
    workspacePath,
    isolated: true,
    intent: 'code',
    provider: '',
    model: '',
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    schedule: { kind: 'cron', expression: '0 9 * * 1-5' },
    period: 'none',
    catchUpHours: 24,
    maxRuntimeMinutes: 30,
    enabled: false,
    trusted: false,
  }
}

/** Validate untrusted IPC/import data in main as well as the editor. */
export function validateRoutine(raw: unknown): RoutineInput {
  if (!raw || typeof raw !== 'object') throw new Error('Invalid routine.')
  const r = raw as Record<string, unknown>
  const text = (key: string, max: number): string => {
    const value = r[key]
    if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) {
      throw new Error(`${key} is required (maximum ${max} characters).`)
    }
    return value.trim()
  }
  const bool = (key: string): boolean => {
    if (typeof r[key] !== 'boolean') throw new Error(`Invalid ${key}.`)
    return r[key]
  }
  const number = (key: string, min: number, max: number): number => {
    const value = r[key]
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
      throw new Error(`${key} must be between ${min} and ${max}.`)
    }
    return value
  }
  const timezone = text('timezone', 100)
  if (!DateTime.now().setZone(timezone).isValid) throw new Error('Choose a valid IANA timezone.')
  const schedule = validateSchedule(r.schedule, timezone)
  if (r.intent !== 'report' && r.intent !== 'code') throw new Error('Invalid task intent.')
  if (!['none', 'previous-day', 'previous-week'].includes(String(r.period)))
    throw new Error('Invalid reporting period.')
  const input: RoutineInput = {
    name: text('name', 100),
    instructions: text('instructions', 32000),
    workspacePath: text('workspacePath', 4096),
    isolated: bool('isolated'),
    intent: r.intent,
    provider: text('provider', 200),
    model: text('model', 300),
    timezone,
    schedule,
    period: r.period as RoutineInput['period'],
    catchUpHours: number('catchUpHours', 0, 168),
    maxRuntimeMinutes: number('maxRuntimeMinutes', 1, 240),
    enabled: bool('enabled'),
    trusted: bool('trusted'),
  }
  if (input.enabled && !input.trusted)
    throw new Error('Acknowledge unattended full tool access before enabling.')
  return input
}

export function validateSchedule(raw: unknown, timezone: string): RoutineSchedule {
  if (!raw || typeof raw !== 'object') throw new Error('Choose a schedule.')
  const s = raw as Record<string, unknown>
  if (s.kind === 'manual') return { kind: 'manual' }
  if (
    s.kind === 'once' &&
    typeof s.at === 'number' &&
    Number.isSafeInteger(s.at) &&
    s.at > 0 &&
    s.at < 8640000000000000
  ) {
    return { kind: 'once', at: s.at }
  }
  if (
    s.kind !== 'cron' ||
    typeof s.expression !== 'string' ||
    s.expression.length > 200 ||
    s.expression.trim().split(/\s+/).length !== 5
  ) {
    throw new Error('Use five-field cron: minute hour day-of-month month weekday.')
  }
  const expression = s.expression.trim()
  // Reject randomized fields: previews and persisted due times must agree.
  if (/H|\?/.test(expression))
    throw new Error('Randomized/unspecified cron fields are not supported.')
  CronExpressionParser.parse(expression, { tz: timezone })
  return { kind: 'cron', expression }
}

/** No timer math: calendar occurrences are evaluated in the saved timezone. */
export function nextOccurrences(
  schedule: RoutineSchedule,
  timezone: string,
  after: number,
  count = 5,
): number[] {
  if (!DateTime.fromMillis(after, { zone: timezone }).isValid)
    throw new Error('Choose a valid timezone and date.')
  if (schedule.kind === 'manual') return []
  if (schedule.kind === 'once') return schedule.at > after ? [schedule.at] : []
  const cron = CronExpressionParser.parse(schedule.expression, {
    currentDate: new Date(after),
    tz: timezone,
    endDate: new Date(Math.min(after + 8 * 366 * 86400000, 8640000000000000)),
  })
  const result: number[] = []
  // Bounded even for hostile expressions. cron-parser skips duplicate DST hours;
  // reject its spring-gap roll-forward when the requested hour doesn't exist.
  for (let attempts = 0; result.length < Math.min(count, 5) && attempts < 100; attempts++) {
    let at: number
    try {
      at = cron.next().getTime()
    } catch {
      break
    }
    const local = DateTime.fromMillis(at, { zone: timezone })
    const first = Math.min(...local.getPossibleOffsets().map((d) => d.toMillis()))
    if (at !== first) continue // repeated wall-clock minute already had its chance
    if (
      !cron.fields.hour.values.some((h) => h === local.hour) ||
      !cron.fields.minute.values.some((m) => m === local.minute)
    )
      continue
    result.push(at)
  }
  return result
}

/** Latest missed occurrence without enumerating months of minute-level runs. */
export function latestOccurrence(routine: Routine, now: number): number {
  if (routine.schedule.kind !== 'cron') return routine.nextAt!
  let cron = CronExpressionParser.parse(routine.schedule.expression, {
    currentDate: new Date(now + 1),
    tz: routine.timezone,
  })
  for (let attempt = 0; attempt < 100; attempt++) {
    const at = cron.prev().getTime()
    const local = DateTime.fromMillis(at, { zone: routine.timezone })
    const first = Math.min(...local.getPossibleOffsets().map((d) => d.toMillis()))
    if (at !== first) {
      // Back past the repeated hour, not just back to this minute's first
      // occurrence: a minute schedule may have run later in the first hour.
      cron = CronExpressionParser.parse(routine.schedule.expression, {
        currentDate: new Date(local.startOf('hour').toMillis()),
        tz: routine.timezone,
      })
      continue
    }
    if (
      cron.fields.hour.values.some((h) => h === local.hour) &&
      cron.fields.minute.values.some((m) => m === local.minute)
    )
      return Math.max(at, routine.nextAt!)
  }
  throw new Error('Could not resolve the missed schedule.')
}

export function routinePeriod(
  routine: RoutineInput,
  scheduledAt: number,
): { start: string; end: string } | null {
  const local = DateTime.fromMillis(scheduledAt, { zone: routine.timezone })
  if (routine.period === 'none') return null
  const end = local.startOf(routine.period === 'previous-week' ? 'week' : 'day')
  const start = end.minus(routine.period === 'previous-week' ? { weeks: 1 } : { days: 1 })
  return { start: start.toISO()!, end: end.toISO()! }
}

export function routinePrompt(run: RoutineRun): string {
  const period = routinePeriod(run.definition, run.scheduledAt)
  return [
    'Run the saved routine below. Finish with a concise outcome, evidence links, and any incomplete or unconfirmed actions.',
    'This is unattended execution. If access, data, or instructions are missing, report the blocker; do not invent success.',
    `Run ID: ${run.id}\nScheduled: ${new Date(run.scheduledAt).toISOString()}\nStarted: ${new Date(run.startedAt!).toISOString()}\nTimezone: ${run.definition.timezone}`,
    period
      ? `Reporting period (end exclusive): ${period.start} to ${period.end}. Use this period even when execution is late.`
      : '',
    'Do not change this routine or its schedule. External writes are not automatically reversible or safe to repeat.',
    run.definition.intent === 'report'
      ? 'This is an analysis/report task, not a request to create code changes or a pull request.'
      : '',
    run.definition.instructions,
  ]
    .filter(Boolean)
    .join('\n\n')
}
