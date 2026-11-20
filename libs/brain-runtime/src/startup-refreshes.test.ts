import { afterEach, expect, it } from 'vitest'
import type { Proposal } from '@phosphor/memory-engine/types'
import { createBrainService } from './service'
import { extractJob } from './extract'
import { returnRefreshesToReview } from './stale-review'
import { FakeBrainStore, HARBOR_JOB } from './__fixtures__/fake-store'
import { pipelineSetup } from './__fixtures__/pipeline'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close()
})

it('a Brain opened with refreshes left from before runs none: they wait in review', async () => {
  const s = await pipelineSetup()
  cleanups.push(s.cleanup)
  await extractJob(s.job, new AbortController().signal, s.store, s.options, s.search)
  const proposal = s.store.storedProposal(s.job.id)
  // An older build marked every stale review refreshing on its own, then Phosphor quit.
  s.store.rev++
  s.store.updateJob(s.job.id, {
    state: 'refreshing',
    runStartedAt: 5,
    error: 'Harbor refresh interrupted',
    progress: { stage: 'identity', done: 1, total: 2 },
  })
  s.runner.mockClear()
  const service = await createBrainService(s.options)
  cleanups.push(() => service.dispose())
  await new Promise((resolve) => setTimeout(resolve, 80))
  expect(s.store.job(s.job.id)).toMatchObject({
    state: 'review',
    runStartedAt: null,
    error: null,
    progress: null,
  })
  expect(s.store.storedProposal(s.job.id)).toBe(proposal)
  expect((await service.api.proposal(s.job.id)).revision).toBe(0)
  expect(s.runner).not.toHaveBeenCalled()
  expect(s.options.log).toHaveBeenCalledWith('Brain left stale reviews waiting for Brain Agent', {
    reviews: 1,
  })
})

it('leaves every other job as it is: no proposal to wait with, or not refreshing', () => {
  const store = new FakeBrainStore()
  const states = ['refreshing', 'queued', 'waiting', 'review', 'done', 'failed'] as const
  const jobs = states.map((state, i) => {
    const job = store.enqueue({ ...HARBOR_JOB, sessionId: `kestrel-${i}` }, 'queued')
    return store.updateJob(job.id, { state, runStartedAt: 7, error: 'Kestrel stays' })
  })
  // Only the review has a stored proposal; the refreshing job has none.
  store.proposals.set(jobs[3]!.id, { jobId: jobs[3]!.id, computedRevision: 0 } as Proposal)
  const now = () => jobs.map((job) => store.job(job.id))
  expect(returnRefreshesToReview(store)).toBe(0)
  expect(now()).toEqual(jobs)
  store.proposals.set(jobs[0]!.id, { jobId: jobs[0]!.id, computedRevision: 0 } as Proposal)
  expect(returnRefreshesToReview(store)).toBe(1)
  expect(store.job(jobs[0]!.id)).toMatchObject({ state: 'review', runStartedAt: null, error: null })
  expect(now().slice(1)).toEqual(jobs.slice(1))
})
