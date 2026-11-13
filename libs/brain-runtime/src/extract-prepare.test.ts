import { appendFile } from 'node:fs/promises'
import { afterEach, expect, it, vi } from 'vitest'
import { fixture, vector } from '@phosphor/memory-engine/test-support'
import { extractJob } from './extract'
import { ExtractionQueue } from './queue'
import { pipelineSetup } from './__fixtures__/pipeline'

it('freezes the advanced leaf at prepare, completes, and retry still reads that leaf', async () => {
  const s = await pipelineSetup()
  afterEach(s.cleanup)
  const { store } = fixture()
  store.setPrefs({ enabled: true, review: false, recall: true })
  s.options.embeddings.embed = async (texts) => texts.map(() => [...vector()])
  const job = store.enqueue({ ...s.job, leafId: 'A' }, 'queued')
  const advance = (id: string) =>
    appendFile(
      s.file,
      '\n' +
        JSON.stringify({
          type: 'message',
          id,
          timestamp: '2026-11-06T13:00:00Z',
          message: { role: 'user', content: 'The build is green.' },
        }),
    )
  await advance('B')
  const queue = new ExtractionQueue({
    store,
    busy: () => false,
    ready: () => true,
    now: () => 123,
    changed() {},
    run: (job, signal) => extractJob(job, signal, store, s.options, s.search),
  })
  afterEach(() => queue.dispose())
  queue.kick()
  await vi.waitFor(() => expect(store.job(job.id)?.state).toBe('done'))
  expect(store.job(job.id)?.leafId).toBe('B')
  await advance('C')
  store.updateJob(job.id, { state: 'failed' })
  queue.retry(job.id)
  await vi.waitFor(() => expect(store.job(job.id)?.state).toBe('done'))
  expect(store.job(job.id)?.leafId).toBe('B')
  expect(s.runner.mock.calls.every(([call]) => call.lane.leafId === 'B')).toBe(true)
})
