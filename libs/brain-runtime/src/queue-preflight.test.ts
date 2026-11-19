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
function setup(
  refusal: (job: import('@phosphor/shared/brain').BrainJob) => Promise<string | null>,
) {
  const store = new FakeBrainStore()
  const run = vi.fn(async () => {})
  const queue = new ExtractionQueue({
    store,
    refusal,
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
it('a failed eligibility read cannot overwrite a review rejected while the file read was pending', async () => {
  let fail!: (error: Error) => void
  const s = setup(
    () =>
      new Promise((_resolve, reject) => {
        fail = reject
      }),
  )
  const job = s.store.enqueue(HARBOR_JOB, 'queued')
  s.store.updateJob(job.id, { state: 'refreshing' })
  s.queue.kick()
  s.store.updateJob(job.id, { state: 'rejected' })
  fail(new Error('Lane deleted'))
  await flush()
  expect(s.store.job(job.id)?.state).toBe('rejected')
  expect(s.run).not.toHaveBeenCalled()
})
