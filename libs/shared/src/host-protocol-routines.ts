import type { RoutineInput, Routine, RoutineRunStatus, RoutineSchedule } from './routines-types'

export const ROUTINE_LIMITS = { routines: 100, history: 50, offset: 100000 } as const
export type RemoteRoutineInput = Omit<RoutineInput, 'workspacePath'> & { repositoryId: string }
export type RemoteRoutine = RemoteRoutineInput &
  Pick<Routine, 'id' | 'revision' | 'createdAt' | 'updatedAt' | 'nextAt' | 'archived'>
export interface RemoteRoutineRun {
  id: string
  routineId: string
  status: RoutineRunStatus
  scheduledAt: number
  startedAt: number | null
  endedAt: number | null
}
export type RoutineOp =
  | {
      type: 'routine.save'
      routine: RemoteRoutineInput
      routineId?: string
      expectedRevision: number | null
    }
  | {
      type: 'routine.run' | 'routine.skipNext' | 'routine.archive' | 'routine.delete'
      routineId: string
    }
  | { type: 'routine.cancel'; runId: string }
  | { type: 'routine.pauseAll' }
export const ROUTINE_OPS = [
  'routine.save',
  'routine.run',
  'routine.cancel',
  'routine.skipNext',
  'routine.archive',
  'routine.delete',
  'routine.pauseAll',
] as const
const fields = [
  'name',
  'instructions',
  'repositoryId',
  'isolated',
  'intent',
  'provider',
  'model',
  'timezone',
  'schedule',
  'period',
  'catchUpHours',
  'maxRuntimeMinutes',
  'enabled',
  'trusted',
]
function record(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
function keys(v: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(v).every((key) => allowed.includes(key))
}
function uuid(v: unknown): v is string {
  return (
    typeof v === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v)
  )
}
function integer(v: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= min && v <= max
}
function time(v: unknown): v is number | null {
  return v === null || integer(v)
}
function input(v: unknown, allowed = fields): RemoteRoutineInput | null {
  if (
    !record(v) ||
    !keys(v, allowed) ||
    typeof v.repositoryId !== 'string' ||
    !/^[0-9a-f]{16}$/.test(v.repositoryId) ||
    !record(v.schedule)
  )
    return null
  const scheduleKeys =
    v.schedule.kind === 'manual'
      ? ['kind']
      : v.schedule.kind === 'once'
        ? ['kind', 'at']
        : ['kind', 'expression']
  if (!keys(v.schedule, scheduleKeys)) return null
  const text = (value: unknown, max: number): value is string =>
    typeof value === 'string' &&
    Boolean(value.trim()) &&
    value.length <= max &&
    !value.includes('\0')
  if (
    !text(v.name, 100) ||
    !text(v.instructions, 32000) ||
    !text(v.provider, 200) ||
    !text(v.model, 300) ||
    !text(v.timezone, 100) ||
    typeof v.isolated !== 'boolean' ||
    typeof v.enabled !== 'boolean' ||
    typeof v.trusted !== 'boolean' ||
    (v.enabled && !v.trusted) ||
    (v.intent !== 'code' && v.intent !== 'report') ||
    (v.period !== 'none' && v.period !== 'previous-day' && v.period !== 'previous-week') ||
    !integer(v.catchUpHours, 0, 168) ||
    !integer(v.maxRuntimeMinutes, 1, 240)
  )
    return null
  let schedule: RoutineSchedule
  if (v.schedule.kind === 'manual') schedule = { kind: 'manual' }
  else if (v.schedule.kind === 'once' && integer(v.schedule.at, 1, 8639999999999999))
    schedule = { kind: 'once', at: v.schedule.at }
  else if (
    v.schedule.kind === 'cron' &&
    text(v.schedule.expression, 200) &&
    v.schedule.expression.trim().split(/\s+/).length === 5 &&
    !/H|\?/.test(v.schedule.expression)
  )
    schedule = { kind: 'cron', expression: v.schedule.expression.trim() }
  else return null
  // Calendar validity is checked by the engine before persistence, without adding Node dependencies here.
  return {
    name: v.name.trim(),
    instructions: v.instructions.trim(),
    repositoryId: v.repositoryId,
    provider: v.provider.trim(),
    model: v.model.trim(),
    timezone: v.timezone.trim(),
    isolated: v.isolated,
    enabled: v.enabled,
    trusted: v.trusted,
    intent: v.intent,
    period: v.period,
    catchUpHours: v.catchUpHours,
    maxRuntimeMinutes: v.maxRuntimeMinutes,
    schedule,
  }
}
export function parseRoutineOp(v: unknown): RoutineOp | null {
  if (!record(v)) return null
  if (v.type === 'routine.pauseAll') return keys(v, ['type']) ? { type: v.type } : null
  if (v.type === 'routine.save') {
    if (!keys(v, ['type', 'routine', 'routineId', 'expectedRevision'])) return null
    const routine = input(v.routine)
    if (
      !routine ||
      (v.routineId !== undefined && !uuid(v.routineId)) ||
      (v.routineId === undefined ? v.expectedRevision !== null : !integer(v.expectedRevision, 1))
    )
      return null
    if (v.expectedRevision !== null && !integer(v.expectedRevision, 1)) return null
    return {
      type: v.type,
      routine,
      expectedRevision: v.expectedRevision,
      ...(v.routineId !== undefined ? { routineId: v.routineId } : {}),
    }
  }
  if (v.type === 'routine.cancel')
    return keys(v, ['type', 'runId']) && uuid(v.runId) ? { type: v.type, runId: v.runId } : null
  if (
    v.type === 'routine.run' ||
    v.type === 'routine.skipNext' ||
    v.type === 'routine.archive' ||
    v.type === 'routine.delete'
  )
    return keys(v, ['type', 'routineId']) && uuid(v.routineId)
      ? { type: v.type, routineId: v.routineId }
      : null
  return null
}
export function routineRequiresControl(op: RoutineOp): boolean {
  return (
    op.type === 'routine.run' ||
    op.type === 'routine.delete' ||
    (op.type === 'routine.save' && (op.routine.enabled || op.routine.trusted))
  )
}
export function parseRoutineParams(
  method: string,
  v: unknown,
): { routineId?: string; offset: number } | null {
  if (!record(v)) return null
  if (method === 'routines.list') return keys(v, []) ? { offset: 0 } : null
  if (
    method !== 'routines.history' ||
    !keys(v, ['routineId', 'offset']) ||
    !uuid(v.routineId) ||
    (v.offset !== undefined && !integer(v.offset, 0, ROUTINE_LIMITS.offset))
  )
    return null
  return { routineId: v.routineId, offset: v.offset ?? 0 }
}
export function parseRoutineList(v: unknown): RemoteRoutine[] | null {
  if (!Array.isArray(v) || v.length > ROUTINE_LIMITS.routines) return null
  const result: RemoteRoutine[] = []
  for (const value of v) {
    if (!record(value)) return null
    const config = input(value, [
      ...fields,
      'id',
      'revision',
      'createdAt',
      'updatedAt',
      'nextAt',
      'archived',
    ])
    if (
      !config ||
      !uuid(value.id) ||
      !integer(value.revision, 1) ||
      !integer(value.createdAt) ||
      !integer(value.updatedAt) ||
      !time(value.nextAt) ||
      typeof value.archived !== 'boolean'
    )
      return null
    result.push({
      ...config,
      id: value.id,
      revision: value.revision,
      createdAt: value.createdAt,
      updatedAt: value.updatedAt,
      nextAt: value.nextAt,
      archived: value.archived,
    })
  }
  return result
}
export function parseRoutineHistory(v: unknown): RemoteRoutineRun[] | null {
  if (!Array.isArray(v) || v.length > ROUTINE_LIMITS.history) return null
  const result: RemoteRoutineRun[] = []
  for (const r of v) {
    if (
      !record(r) ||
      !keys(r, ['id', 'routineId', 'status', 'scheduledAt', 'startedAt', 'endedAt']) ||
      !uuid(r.id) ||
      !uuid(r.routineId) ||
      !integer(r.scheduledAt) ||
      !time(r.startedAt) ||
      !time(r.endedAt)
    )
      return null
    const status = r.status
    if (
      status !== 'queued' &&
      status !== 'running' &&
      status !== 'finished' &&
      status !== 'failed' &&
      status !== 'blocked' &&
      status !== 'interrupted' &&
      status !== 'cancelled' &&
      status !== 'timed-out' &&
      status !== 'skipped'
    )
      return null
    result.push({
      id: r.id,
      routineId: r.routineId,
      status,
      scheduledAt: r.scheduledAt,
      startedAt: r.startedAt,
      endedAt: r.endedAt,
    })
  }
  return result
}
