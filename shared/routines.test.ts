import { describe, expect, it } from 'vitest'
import {
  latestOccurrence,
  newRoutine,
  nextOccurrences,
  routinePeriod,
  routinePrompt,
  validateRoutine,
  validateSchedule,
  type Routine,
} from './routines'

const at = (date: string): number => Date.parse(date)
const cron = (expression: string): { kind: 'cron'; expression: string } => ({
  kind: 'cron',
  expression,
})
const iso = (times: number[]): string[] => times.map((t) => new Date(t).toISOString())
function routine(expression: string, timezone = 'UTC', nextAt = at('2026-01-01T00:00Z')): Routine {
  return {
    ...newRoutine('/workspace'),
    schedule: cron(expression),
    timezone,
    id: 'r',
    revision: 1,
    createdAt: nextAt,
    updatedAt: nextAt,
    nextAt,
    attention: null,
    archived: false,
  }
}

describe('routine calendar', () => {
  it('previews weekdays in a pinned timezone, independent of machine timezone', () => {
    expect(
      iso(
        nextOccurrences(
          cron('0 9 * * 1-5'),
          'America/Argentina/Buenos_Aires',
          at('2026-09-18T12:00Z'),
          2,
        ),
      ),
    ).toEqual(['2026-09-21T12:00:00.000Z', '2026-09-22T12:00:00.000Z'])
  })
  it('handles manual and one-off schedules', () => {
    expect(nextOccurrences({ kind: 'manual' }, 'UTC', 0)).toEqual([])
    expect(nextOccurrences({ kind: 'once', at: 1000 }, 'UTC', 0)).toEqual([1000])
    expect(nextOccurrences({ kind: 'once', at: 1000 }, 'UTC', 1000)).toEqual([])
  })
  it('skips missing monthly dates and supports last-day/leap-day', () => {
    expect(iso(nextOccurrences(cron('0 9 31 * *'), 'UTC', at('2026-01-31T09:00Z'), 1))).toEqual([
      '2026-03-31T09:00:00.000Z',
    ])
    expect(iso(nextOccurrences(cron('0 9 L * *'), 'UTC', at('2028-02-01T00:00Z'), 1))).toEqual([
      '2028-02-29T09:00:00.000Z',
    ])
    expect(iso(nextOccurrences(cron('0 0 29 2 *'), 'UTC', at('2026-01-01T00:00Z'), 1))).toEqual([
      '2028-02-29T00:00:00.000Z',
    ])
  })
  it('uses conventional DOM/DOW OR semantics', () => {
    const values = iso(nextOccurrences(cron('0 9 1 * 1'), 'UTC', at('2026-09-01T09:00Z'), 2))
    expect(values).toEqual(['2026-09-07T09:00:00.000Z', '2026-09-14T09:00:00.000Z'])
  })
  it('skips the nonexistent spring-forward hour instead of rolling to 03:30', () => {
    expect(
      iso(nextOccurrences(cron('30 2 * * *'), 'America/New_York', at('2026-03-07T08:00Z'), 2)),
    ).toEqual(['2026-03-09T06:30:00.000Z', '2026-03-10T06:30:00.000Z'])
  })
  it('runs the repeated fall-back wall time only once', () => {
    expect(
      iso(nextOccurrences(cron('30 1 * * *'), 'America/New_York', at('2026-11-01T04:00Z'), 2)),
    ).toEqual(['2026-11-01T05:30:00.000Z', '2026-11-02T06:30:00.000Z'])
    expect(
      iso(nextOccurrences(cron('30 1 * * *'), 'America/New_York', at('2026-11-01T05:30Z'), 1)),
    ).toEqual(['2026-11-02T06:30:00.000Z'])
  })
  it('does not replay repeated-hour minutes, including catch-up after wake', () => {
    expect(
      iso(nextOccurrences(cron('* * * * *'), 'America/New_York', at('2026-11-01T05:59Z'), 1)),
    ).toEqual(['2026-11-01T07:00:00.000Z'])
    const r = routine('* * * * *', 'America/New_York', at('2026-11-01T04:00Z'))
    expect(new Date(latestOccurrence(r, at('2026-11-01T06:15Z'))).toISOString()).toBe(
      '2026-11-01T05:59:00.000Z',
    )
  })
  it('finds a latest occurrence without enumerating every minute of downtime', () => {
    expect(latestOccurrence(routine('* * * * *'), at('2026-09-21T09:43:20Z'))).toBe(
      at('2026-09-21T09:43Z'),
    )
  })
  it('rejects an impossible calendar expression without an unbounded loop', () => {
    expect(() => nextOccurrences(cron('0 9 31 2 *'), 'UTC', at('2026-01-01T00:00Z'))).toThrow(
      'day of month',
    )
  })
  it('uses the scheduled reporting week, not the delayed start date', () => {
    const r = { ...routine('0 9 * * 1', 'America/New_York'), period: 'previous-week' as const }
    expect(routinePeriod(r, at('2026-03-09T13:00Z'))).toEqual({
      start: '2026-03-02T00:00:00.000-05:00',
      end: '2026-03-09T00:00:00.000-04:00',
    })
    expect(routinePeriod({ ...r, period: 'previous-day' }, at('2026-03-09T13:00Z'))?.start).toBe(
      '2026-03-08T00:00:00.000-05:00',
    )
  })
})

describe('untrusted configuration', () => {
  const valid = {
    ...newRoutine('/workspace'),
    name: 'Report',
    instructions: 'Analyze data.',
    provider: 'anthropic',
    model: 'test-model',
  }
  it('requires explicit unattended acknowledgement', () => {
    expect(() => validateRoutine({ ...valid, enabled: true })).toThrow('Acknowledge')
    expect(validateRoutine({ ...valid, enabled: true, trusted: true }).enabled).toBe(true)
  })
  it.each([
    { maxRuntimeMinutes: 0 },
    { catchUpHours: -1 },
    { catchUpHours: 169 },
    { maxRuntimeMinutes: Infinity },
    { instructions: '' },
    { workspacePath: '\0bad' },
    { model: '' },
    { timezone: 'Not/A_Zone' },
    { enabled: 'yes' },
    { intent: 'admin' },
  ])('rejects invalid field %j', (patch) =>
    expect(() => validateRoutine({ ...valid, ...patch })).toThrow(),
  )
  it.each([
    '* * * * * *',
    '@hourly',
    'H 9 * * *',
    '999 * * * *',
    '*/0 * * * *',
    '0 9 * * *; rm -rf /',
  ])('rejects unsupported cron %s', (expression) => {
    expect(() => validateSchedule(cron(expression), 'UTC')).toThrow()
  })
  it('does not import unknown fields or credentials', () => {
    expect(validateRoutine({ ...valid, token: 'secret', id: 'injected' })).not.toHaveProperty(
      'token',
    )
    expect(validateRoutine({ ...valid, token: 'secret', id: 'injected' })).not.toHaveProperty('id')
  })
  it('explains task intent and immutable period in the prompt', () => {
    const definition = {
      ...routine('0 9 * * 1'),
      instructions: 'Read the runbook.',
      period: 'previous-week' as const,
      intent: 'report' as const,
    }
    const prompt = routinePrompt({
      id: 'run',
      definition,
      scheduledAt: at('2026-09-21T09:00Z'),
      startedAt: at('2026-09-28T09:00Z'),
    } as Parameters<typeof routinePrompt>[0])
    expect(prompt).toContain('2026-09-14T00:00:00.000Z to 2026-09-21T00:00:00.000Z')
    expect(prompt).toContain('not a request to create code changes')
    expect(prompt).toContain('Read the runbook.')
  })
})
