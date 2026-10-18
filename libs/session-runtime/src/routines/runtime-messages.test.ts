import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newRoutine } from '@phosphor/shared/routines'
import { RoutineRepository } from './repository'
import { RoutineScheduler, type RoutineExecutor } from './scheduler'
import { loadRoutineSqlite } from './sqlite'

const now = Date.parse('2026-09-21T08:00Z')
const fixtures: { repo: RoutineRepository; scheduler: RoutineScheduler }[] = []
const execute: RoutineExecutor = (_run, signal) =>
  new Promise((resolve) => {
    signal.addEventListener('abort', () => resolve({ status: 'cancelled', reason: 'Stopped' }), {
      once: true,
    })
  })
function fixture() {
  const repo = new RoutineRepository(':memory:')
  const scheduler = new RoutineScheduler(
    repo,
    execute,
    () => {},
    () => now,
  )
  fixtures.push({ repo, scheduler })
  const routine = repo.save(
    {
      ...newRoutine('/workspace'),
      name: 'Messages',
      instructions: 'Test',
      model: 'test',
      provider: 'test',
      trusted: true,
    },
    now,
  )
  return { repo, scheduler, routine }
}
afterEach(async () => {
  vi.restoreAllMocks()
  for (const { repo, scheduler } of fixtures.splice(0)) {
    await scheduler.stop()
    repo.close()
  }
})

it('requires a newer runtime rather than a specific product for a newer database', () => {
  const directory = mkdtempSync(join(tmpdir(), 'routine-newer-db-'))
  const path = join(directory, 'routines.sqlite')
  const { DatabaseSync } = loadRoutineSqlite()
  const db = new DatabaseSync(path)
  db.exec('PRAGMA user_version=2')
  db.close()
  try {
    expect(() => new RoutineRepository(path)).toThrow(
      'Routines database is newer than this runtime. Upgrade the runtime.',
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

it('recovers with a neutral interruption warning preserving external effects and no replay', () => {
  const { repo, routine } = fixture()
  const run = repo.manual(routine.id, 'run', now)
  repo.claim(run.id, now)
  repo.recover(now + 1)
  expect(repo.run(run.id)).toMatchObject({
    status: 'interrupted',
    reason:
      'Runtime stopped during execution; external actions may have completed. Verify the previous worker has stopped and inspect its output before saving to resume. No automatic replay.',
  })
  expect(repo.get(routine.id)).toMatchObject({
    enabled: false,
    attention: repo.run(run.id).reason,
  })
  expect(repo.pending()).toEqual([])
})

it('stops active execution with a neutral partial-output and no-replay warning', async () => {
  const { repo, scheduler, routine } = fixture()
  const run = scheduler.runNow(routine.id, 'run')
  await scheduler.stop()
  expect(repo.run(run.id)).toMatchObject({
    status: 'interrupted',
    reason:
      'Runtime quit or restarted during this run. Inspect any partial output before resuming; nothing was replayed.',
  })
  expect(repo.get(routine.id).enabled).toBe(false)
})

it('refuses Run now during shutdown with a neutral shutting-down diagnostic', async () => {
  const { repo, scheduler, routine } = fixture()
  await scheduler.stop()
  expect(() => scheduler.runNow(routine.id, 'blocked')).toThrow('Runtime is shutting down.')
  expect(repo.history()).toEqual([])
})

it('fails closed with neutral restart guidance and unchanged interrupted admission', async () => {
  const { repo, scheduler, routine } = fixture()
  const run = scheduler.runNow(routine.id, 'run')
  vi.spyOn(repo, 'reconcile').mockImplementation(() => {
    throw new Error('disk full')
  })
  scheduler.tick()
  const message =
    'Routine scheduling stopped: Error: disk full. Restart the runtime after resolving the problem.'
  expect(scheduler.snapshot().error).toBe(message)
  expect(() => scheduler.runNow(routine.id, 'blocked')).toThrow(message)
  await vi.waitFor(() => expect(repo.run(run.id).status).toBe('interrupted'))
  expect(repo.run(run.id).reason).toBe(message)
  expect(repo.history()).toHaveLength(1)
})
