import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newRoutine, type RoutineInput } from '@shared/routines'
import { RoutineRepository } from './repository'

const now = Date.parse('2026-09-21T08:00Z')
const hour = 3600000
const input = (patch: Partial<RoutineInput> = {}): RoutineInput => ({
  ...newRoutine('/workspace'),
  name: 'Test',
  instructions: 'Write a report.',
  model: 'test',
  provider: 'test',
  timezone: 'UTC',
  enabled: true,
  trusted: true,
  schedule: { kind: 'cron', expression: '0 9 * * *' },
  ...patch,
})
let repo: RoutineRepository
let directory: string
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'routine-db-'))
  repo = new RoutineRepository(join(directory, 'routines.sqlite'))
})
afterEach(() => {
  repo.close()
  rmSync(directory, { recursive: true, force: true })
})

describe('durable routine ledger', () => {
  it('atomically schedules and deduplicates an occurrence', () => {
    const r = repo.save(input(), now)
    repo.reconcile(now + hour)
    repo.reconcile(now + hour)
    expect(repo.history(r.id)).toHaveLength(1)
    expect(repo.get(r.id).nextAt).toBe(now + 25 * hour)
    const run = repo.history(r.id)[0]!
    expect(repo.claim(run.id, now + hour)?.status).toBe('running')
    expect(repo.claim(run.id, now + hour)).toBeNull()
  })
  it('keeps immutable run configuration and refuses stale edits', () => {
    const r = repo.save(input(), now)
    const run = repo.manual(r.id, 'click', now)
    repo.claim(run.id, now)
    repo.save({ ...r, instructions: 'Changed.', enabled: false }, now + 1, r.id, r.revision)
    expect(repo.run(run.id).definition.instructions).toBe('Write a report.')
    expect(() => repo.save(input(), now, r.id, r.revision)).toThrow('changed')
  })
  it('Run now is idempotent, cannot overlap, and does not move the schedule', () => {
    const r = repo.save(input(), now)
    const run = repo.manual(r.id, 'click', now)
    expect(repo.manual(r.id, 'double-click', now).id).toBe(run.id)
    repo.claim(run.id, now)
    expect(repo.manual(r.id, 'another-click', now).id).toBe(run.id)
    repo.finish(run.id, 'finished', 'unverified', now + 1)
    expect(repo.manual(r.id, 'click', now + 2).id).toBe(run.id)
    expect(repo.get(r.id).nextAt).toBe(now + hour)
  })
  it('coalesces long downtime into one eligible latest occurrence and a skipped range', () => {
    const r = repo.save(input({ schedule: { kind: 'cron', expression: '* * * * *' } }), now)
    repo.reconcile(now + 60 * 24 * hour)
    const history = repo.history(r.id)
    expect(history).toHaveLength(2)
    expect(history.filter((r) => r.status === 'queued')).toHaveLength(1)
    expect(history.find((r) => r.status === 'skipped')?.reason).toContain('coalesced')
  })
  it('skips expired occurrences and queued work', () => {
    const r = repo.save(input({ catchUpHours: 0 }), now)
    repo.reconcile(now + 2 * hour)
    expect(repo.history(r.id)[0]?.status).toBe('skipped')
    const manual = repo.manual(r.id, 'manual', now + 2 * hour)
    expect(repo.claim(manual.id, now + 3 * hour)).toBeNull()
    expect(repo.run(manual.id).status).toBe('skipped')
  })
  it('keeps one pending scheduled run while a previous run is active', () => {
    const r = repo.save(input({ schedule: { kind: 'cron', expression: '* * * * *' } }), now)
    const run = repo.manual(r.id, 'manual', now)
    repo.claim(run.id, now)
    repo.reconcile(now + 60000)
    repo.reconcile(now + 120000)
    expect(repo.pending()).toHaveLength(2)
    expect(repo.pending().find((r) => r.status === 'queued')?.scheduledAt).toBe(now + 120000)
  })
  it('pause cancels queued snapshots, leaves active work alone, and does not catch up paused time', () => {
    let r = repo.save(input(), now)
    const manual = repo.manual(r.id, 'manual', now)
    repo.claim(manual.id, now)
    repo.reconcile(now + hour)
    r = repo.save({ ...r, enabled: false }, now + hour, r.id, r.revision)
    expect(repo.pending().map((r) => r.id)).toEqual([manual.id])
    repo.reconcile(now + 2 * 24 * hour)
    r = repo.save({ ...r, enabled: true }, now + 2 * 24 * hour, r.id, r.revision)
    expect(r.nextAt).toBe(now + 49 * hour)
  })
  it('skip-next advances the cursor and preserves an explicit reason', () => {
    const r = repo.save(input(), now)
    repo.skipNext(r.id, now)
    repo.reconcile(now + hour)
    expect(repo.history(r.id)).toHaveLength(1)
    expect(repo.history(r.id)[0]?.reason).toBe('Skipped by you.')
    expect(repo.get(r.id).nextAt).toBe(now + 25 * hour)
  })
  it('recovers interrupted work without replay and pauses the definition', () => {
    const r = repo.save(input(), now)
    const run = repo.manual(r.id, 'click', now)
    repo.claim(run.id, now)
    repo.patchRun(run.id, { workspacePath: '/isolated', sessionPath: '/pi/session.jsonl' })
    repo.close()
    repo = new RoutineRepository(join(directory, 'routines.sqlite'))
    repo.recover(now + 10000)
    expect(repo.run(run.id).status).toBe('interrupted')
    expect(repo.run(run.id).sessionPath).toBe('/pi/session.jsonl')
    expect(repo.get(r.id).enabled).toBe(false)
    expect(repo.get(r.id).attention).toContain('No automatic replay')
    expect(() => repo.manual(r.id, 'again', now)).toThrow('attention')
    repo.reconcile(now + 24 * hour)
    expect(repo.pending()).toEqual([])
  })
  it('blocks immediately for auth; pauses after three consecutive execution failures', () => {
    const r = repo.save(input(), now)
    for (let n = 0; n < 3; n++) {
      const run = repo.manual(r.id, `run-${n}`, now + n)
      repo.claim(run.id, now + n)
      repo.finish(run.id, 'failed', 'Provider failed.', now + n + 1)
    }
    expect(repo.get(r.id).attention).toBe('Provider failed.')
    expect(repo.get(r.id).enabled).toBe(false)
    const other = repo.save(input(), now)
    const run = repo.manual(other.id, 'auth', now)
    repo.finish(run.id, 'blocked', 'Sign in.', now)
    expect(repo.get(other.id).enabled).toBe(false)
  })
  it('archives without deleting history and refuses to archive running work', () => {
    const r = repo.save(input(), now)
    const run = repo.manual(r.id, 'click', now)
    repo.claim(run.id, now)
    expect(() => repo.archive(r.id, now)).toThrow('Cancel')
    repo.finish(run.id, 'finished', '', now)
    repo.archive(r.id, now)
    expect(repo.get(r.id).archived).toBe(true)
    expect(repo.history(r.id)).toHaveLength(1)
  })
  it('one-off schedules do not repeat after restart', () => {
    const r = repo.save(input({ schedule: { kind: 'once', at: now + hour } }), now)
    repo.reconcile(now + hour)
    expect(repo.get(r.id).nextAt).toBeNull()
    repo.reconcile(now + 2 * hour)
    expect(repo.history(r.id)).toHaveLength(1)
  })
  it('indexes routine-owned lanes and releases a promoted one', () => {
    const r = repo.save(input(), now)
    const run = repo.manual(r.id, 'click', now)
    // A run with no transcript yet cannot be hidden or handed back.
    expect(repo.laneIndex()).toEqual({})
    expect(() => repo.promote(run.id)).toThrow('no transcript')
    repo.patchRun(run.id, { sessionPath: '/sessions/a.jsonl' })
    expect(repo.laneIndex()).toEqual({
      '/sessions/a.jsonl': { routineId: r.id, runId: run.id },
    })
    repo.promote(run.id)
    expect(repo.laneIndex()).toEqual({})
    expect(repo.run(run.id).promoted).toBe(true)
  })
  it('indexes lanes older than the snapshot window and survives restart', () => {
    const r = repo.save(input(), now)
    for (let i = 0; i < 205; i++) {
      const run = repo.manual(r.id, `click-${i}`, now + i)
      repo.patchRun(run.id, { sessionPath: `/sessions/${i}.jsonl` })
      repo.finish(run.id, 'finished', '', now + i)
    }
    repo.close()
    repo = new RoutineRepository(join(directory, 'routines.sqlite'))
    const index = repo.laneIndex()
    expect(Object.keys(index)).toHaveLength(205)
    expect(index['/sessions/0.jsonl']).toEqual({ routineId: r.id, runId: expect.any(String) })
  })
  it('persists opt-in background mode', () => {
    expect(repo.background()).toBe(false)
    repo.setBackground(true)
    repo.close()
    repo = new RoutineRepository(join(directory, 'routines.sqlite'))
    expect(repo.background()).toBe(true)
  })
})
