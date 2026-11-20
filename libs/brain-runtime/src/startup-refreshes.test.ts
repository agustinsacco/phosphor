import { afterEach, expect, it } from 'vitest'
import { createBrainService } from './service'
import { extractJob } from './extract'
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
