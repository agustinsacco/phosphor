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
  machine?: { id: string; label: string; repositoryId: string; control: boolean }
}

/**
 * Result of a setup check. `warning` names a condition that would refuse the
 * run right now but may well have cleared by the scheduled time, so it never
 * blocks a save — only a permanent misconfiguration throws.
 */
export interface RoutineCheck {
  summary: string
  warning: string | null
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
  /**
   * Set once this run's lane has been opened from routine history.
   *
   * A promoted lane leaves the lane index, so the sidebar lists it as an
   * ordinary session again. Absent on every run recorded before promotion
   * existed, which is why it is optional rather than defaulted in `insert`.
   */
  promoted?: boolean
}

/**
 * Session file path → the run that produced it, for every routine lane the
 * routine still owns. Promoted lanes are deliberately absent: the sidebar
 * hides exactly the paths in this index, so continuing a lane is the same
 * operation as giving it back to its workspace.
 */
export type RoutineLaneIndex = Record<string, { routineId: string; runId: string }>

export interface RoutinesSnapshot {
  machines?: RoutineMachine[]
  routines: Routine[]
  runs: RoutineRun[]
  background: boolean
  error: string | null
}

export interface RoutineMachine {
  id: string
  label: string
  available: boolean
  control: boolean
  repositories: { id: string; name: string }[]
}
