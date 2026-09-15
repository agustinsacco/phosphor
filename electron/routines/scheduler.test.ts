import { afterEach, describe, expect, it, vi } from 'vitest'
import { newRoutine } from '@shared/routines'
import { RoutineRepository } from './repository'
import { RoutineScheduler, type RoutineExecutor } from './scheduler'

const fixtures: { repo: RoutineRepository; scheduler: RoutineScheduler }[] = []
function harness(
  execute: RoutineExecutor,
  now: () => number = () => Date.parse('2026-09-21T08:00Z'),
) {
  const repo = new RoutineRepository(':memory:')
  const scheduler = new RoutineScheduler(repo, execute, () => {}, now)
  fixtures.push({ repo, scheduler })
  const add = (workspace = '/workspace') =>
    repo.save(
      {
        ...newRoutine(workspace),
        name: 'Test',
        instructions: 'Test',
        provider: 'test',
        model: 'test',
        trusted: true,
        enabled: false,
      },
      now(),
    )
  return { repo, scheduler, add }
}
afterEach(async () => {
  for (const f of fixtures.splice(0)) {
    await f.scheduler.stop()
    f.repo.close()
  }
  vi.useRealTimers()
})
const pending: RoutineExecutor = (_run, signal) =>
  new Promise((resolve) => {
    signal.addEventListener('abort', () => resolve({ status: 'cancelled', reason: 'cancel' }), {
      once: true,
    })
  })

describe('routine-only admission', () => {
  it('limits execution to two workers and serializes a shared workspace', async () => {
    const execute = vi.fn(pending)
    const h = harness(execute)
    const a = h.add('/a'),
      b = h.add('/a'),
      c = h.add('/c'),
      d = h.add('/d')
    const ra = h.scheduler.runNow(a.id, 'a')
    h.scheduler.runNow(b.id, 'b')
    h.scheduler.runNow(c.id, 'c')
    h.scheduler.runNow(d.id, 'd')
    expect(execute).toHaveBeenCalledTimes(2)
    expect(h.repo.pending().filter((r) => r.status === 'queued')).toHaveLength(2)
    h.scheduler.cancel(ra.id)
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(3))
  })
  it('cancels queued work without spawning a process', () => {
    const execute = vi.fn(pending)
    const h = harness(execute)
    h.scheduler.runNow(h.add('/a').id, 'a')
    const queued = h.scheduler.runNow(h.add('/a').id, 'b')
    h.scheduler.cancel(queued.id)
    expect(h.repo.run(queued.id).status).toBe('cancelled')
    expect(execute).toHaveBeenCalledTimes(1)
  })
  it('records progress and a conservative finished result', async () => {
    const h = harness(async (_run, _signal, progress) => {
      progress({ sessionPath: '/pi/session', workspacePath: '/worktree' })
      return { status: 'finished', reason: 'unverified', summary: 'Report ready.' }
    })
    const run = h.scheduler.runNow(h.add().id, 'run')
    await vi.waitFor(() => expect(h.repo.run(run.id).status).toBe('finished'))
    expect(h.repo.run(run.id).summary).toBe('Report ready.')
    expect(h.repo.run(run.id).sessionPath).toBe('/pi/session')
  })
  it('enforces runtime deadlines and persists timeout rather than cancellation', async () => {
    vi.useFakeTimers()
    const h = harness(pending, () => Date.now())
    const run = h.scheduler.runNow(h.add().id, 'run')
    await vi.advanceTimersByTimeAsync(30 * 60000)
    expect(h.repo.run(run.id).status).toBe('timed-out')
  })
  it('does not re-admit work on shutdown, and marks active outcomes unknown', async () => {
    const execute = vi.fn(pending)
    const h = harness(execute)
    const run = h.scheduler.runNow(h.add().id, 'run')
    await h.scheduler.stop()
    expect(h.repo.run(run.id).status).toBe('interrupted')
    expect(h.repo.get(run.routineId).enabled).toBe(false)
    expect(() => h.scheduler.runNow(h.add('/b').id, 'new')).toThrow('shutting down')
    expect(execute).toHaveBeenCalledTimes(1)
  })
  it('fails closed on a persistence error and stops its own execution', async () => {
    const h = harness(pending)
    const run = h.scheduler.runNow(h.add().id, 'run')
    vi.spyOn(h.repo, 'reconcile').mockImplementation(() => {
      throw new Error('disk full')
    })
    h.scheduler.tick()
    expect(h.scheduler.snapshot().error).toContain('disk full')
    await vi.waitFor(() => expect(h.repo.run(run.id).status).not.toBe('running'))
    expect(() => h.scheduler.runNow(run.routineId, 'another')).toThrow('disk full')
  })
})
