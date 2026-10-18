import { afterEach, describe, expect, it, vi } from 'vitest'
import { newRoutine } from '@shared/routines'
import { shutdownApproval } from '../shutdown-approval'
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
  it('pauses admission without consuming queued work while shutdown is approved', () => {
    const execute = vi.fn(pending)
    const h = harness(execute)
    const definition = h.add()
    const run = h.repo.manual(definition.id, 'queued', Date.parse('2026-09-21T08:00Z'))
    const closing = vi.spyOn(shutdownApproval, 'closing', 'get').mockReturnValue(true)
    try {
      h.scheduler.tick()
      expect(execute).not.toHaveBeenCalled()
      expect(h.repo.run(run.id).status).toBe('queued')
      expect(() => h.scheduler.runNow(definition.id, 'new')).toThrow('shutting down')
      closing.mockReturnValue(false)
      h.scheduler.tick()
      expect(execute).toHaveBeenCalledTimes(1)
    } finally {
      closing.mockRestore()
    }
  })
})
