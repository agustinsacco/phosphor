import { expect, it, vi } from 'vitest'
import { ExtractionQueue } from './queue'
import { FakeBrainStore, HARBOR_JOB } from './__fixtures__/fake-store'

it('reports queue-only cancellation once, but not active cancellation or inbox dismissal', async () => {
  const store = new FakeBrainStore()
  const cancelled = vi.fn()
  const options = {
    store,
    cancelled,
    busy: () => false,
    ready: () => true,
    changed: () => {},
    now: () => 123,
    run: async (_job: unknown, signal: AbortSignal) => {
      signal.throwIfAborted()
    },
  }
  const queue = new ExtractionQueue(options)
  const queued = store.enqueue(HARBOR_JOB, 'queued')
  queue.cancel(queued.id)
  const waiting = store.enqueue(HARBOR_JOB, 'waiting')
  queue.cancel(waiting.id)
  expect(cancelled).toHaveBeenCalledTimes(2)
  expect(cancelled.mock.calls.map(([job]) => [job.id, job.state])).toEqual([
    [queued.id, 'queued'],
    [waiting.id, 'waiting'],
  ])
  const active = store.enqueue(HARBOR_JOB, 'queued')
  queue.kick()
  queue.cancel(active.id)
  await queue.dispose()
  const empty = store.enqueue(HARBOR_JOB, 'queued')
  store.updateJob(empty.id, { state: 'empty' })
  queue.cancel(empty.id)
  expect(cancelled).toHaveBeenCalledTimes(2)
})
