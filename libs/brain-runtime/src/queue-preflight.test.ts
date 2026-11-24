import { DeletedLaneError } from './transcript'
import { extraction } from '@phosphor/memory-engine/test-support'
import type { BrainJob } from '@phosphor/shared/brain'
import { afterEach, expect, it, vi } from 'vitest'
import { ExtractionQueue } from './queue'
import { FakeBrainStore, HARBOR_JOB } from './__fixtures__/fake-store'

const queues: ExtractionQueue[] = []
afterEach(async () => {
  for (const queue of queues.splice(0)) await queue.dispose()
})
const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}
function setup(refusal: (job: BrainJob) => Promise<string | null>) {
  const store = new FakeBrainStore()
  const run = vi.fn(async () => {})
  const queue = new ExtractionQueue({
    store,
    check: async (job) => ({ refusal: await refusal(job) }),
    run,
    busy: () => false,
    ready: () => true,
    changed() {},
    now: () => 123,
  })
  queues.push(queue)
  return { store, queue, run }
}
it('an idle kick does not admit a job added during an empty asynchronous eligibility scan', async () => {
  const s = setup(async () => null)
  s.queue.kick()
  // A producer stages a job before its own asynchronous prepare/propose completes.
  const job = s.store.enqueue(HARBOR_JOB, 'queued')
  await flush()
  expect(s.run).not.toHaveBeenCalled()
  expect(s.store.job(job.id)?.state).toBe('queued')
})
it('fails a stale legacy read when its lane was deleted and lets it be dismissed', async () => {
  const s = setup(async (job) => {
    throw new DeletedLaneError(job.sessionPath)
  })
  const job = s.store.enqueue(HARBOR_JOB, 'queued')
  s.store.proposals.set(job.id, extraction(job.id, { computedRevision: -1 }))
  s.queue.kick()
  await vi.waitFor(() =>
    expect(s.store.job(job.id)).toMatchObject({
      state: 'failed',
      error: "This lane was deleted, so Brain can't finish reading it.",
    }),
  )
  s.queue.cancel(job.id)
  expect(s.store.job(job.id)).toBeUndefined()
})
