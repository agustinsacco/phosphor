import { describe, expect, it } from 'vitest'
import { DateTime } from 'luxon'
import { newRoutine, type Routine, type RoutineRun } from '@shared/routines'
import { ALL_RUNS, filterRuns, groupRunsByDay, isOneOff } from './runGroups'

const now = DateTime.fromISO('2026-09-19T14:00').toMillis()
const hour = 3600000
const definition = (patch: Partial<Routine> = {}): Routine =>
  ({
    ...newRoutine('/repo'),
    id: 'r1',
    name: 'Weekly report',
    schedule: { kind: 'cron', expression: '0 9 * * 1' },
    timezone: 'UTC',
    revision: 1,
    ...patch,
  }) as Routine
const run = (patch: Partial<RoutineRun> = {}): RoutineRun =>
  ({
    id: crypto.randomUUID(),
    routineId: 'r1',
    trigger: 'schedule',
    createdAt: now,
    scheduledAt: now,
    startedAt: null,
    endedAt: null,
    status: 'finished',
    reason: '',
    definition: definition(),
    sessionId: null,
    sessionPath: null,
    workspacePath: '/repo',
    branch: null,
    baseCommit: null,
    accountId: null,
    summary: '',
    ...patch,
  }) as RoutineRun

describe('groupRunsByDay', () => {
  it('names the recent days and keeps both orders newest first', () => {
    const days = groupRunsByDay(
      [
        run({ scheduledAt: now - 48 * hour }),
        run({ scheduledAt: now - 6 * hour }),
        run({ scheduledAt: now - 26 * hour }),
        run({ scheduledAt: now - hour }),
      ],
      now,
    )
    expect(days.map((d) => d.label)).toEqual(['Today', 'Yesterday', 'Thursday, 17 September'])
    expect(days[0]!.runs.map((r) => r.scheduledAt)).toEqual([now - hour, now - 6 * hour])
  })
  it('groups by the started time when a run did not start on its scheduled day', () => {
    // A queued occurrence claimed after midnight belongs to the day it ran.
    const days = groupRunsByDay(
      [run({ scheduledAt: now - 30 * hour, startedAt: now - 2 * hour })],
      now,
    )
    expect(days.map((d) => d.label)).toEqual(['Today'])
  })
  it('drops the weekday name once a run is more than a year old', () => {
    const days = groupRunsByDay([run({ scheduledAt: now - 400 * 24 * hour })], now)
    expect(days[0]?.label).toBe('15 August 2025')
  })
})

describe('filterRuns', () => {
  const runs = [
    run({ id: 'a', trigger: 'manual' }),
    run({ id: 'b', routineId: 'r2', status: 'failed', workspacePath: '/other' }),
    run({ id: 'c', status: 'running' }),
    run({ id: 'd', definition: definition({ schedule: { kind: 'once', at: now } }) }),
  ]
  const ids = (filter: Parameters<typeof filterRuns>[1]): string[] =>
    filterRuns(runs, filter).map((r) => r.id)

  it('passes everything through by default', () => {
    expect(ids(ALL_RUNS)).toEqual(['a', 'b', 'c', 'd'])
  })
  it('treats Run now and a one-time schedule as the same one-off trigger', () => {
    expect(isOneOff(runs[0]!)).toBe(true)
    expect(ids({ ...ALL_RUNS, trigger: 'one-off' })).toEqual(['a', 'd'])
    expect(ids({ ...ALL_RUNS, trigger: 'scheduled' })).toEqual(['b', 'c'])
  })
  it('counts no outcome as a failure, but not work still in flight', () => {
    expect(ids({ ...ALL_RUNS, failedOnly: true })).toEqual(['b'])
  })
  it('combines routine and workspace without widening either', () => {
    expect(ids({ ...ALL_RUNS, routineId: 'r2', workspacePath: '/other' })).toEqual(['b'])
    expect(ids({ ...ALL_RUNS, routineId: 'r2', workspacePath: '/repo' })).toEqual([])
  })
})
