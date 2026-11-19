import { unlink } from 'node:fs/promises'
import { afterEach, expect, it, vi } from 'vitest'
import { createBrainService } from './service'
import { extractJob } from './extract'
import { pipelineSetup } from './__fixtures__/pipeline'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close()
})
it('keeps a missing lane review in the Inbox, refuses Approve with a remedy, and allows Reject', async () => {
  const s = await pipelineSetup()
  cleanups.push(s.cleanup)
  s.store.jobs = []
  const service = await createBrainService(s.options)
  cleanups.push(() => service.dispose())
  const id = (await service.api.queue({ sessionPath: s.file, title: 'Harbor' })).jobs[0]!.id
  await vi.waitFor(() => expect(s.store.job(id)?.state).toBe('review'))
  s.runner.mockClear()
  await unlink(s.file)
  s.store.rev++
  await service.api.setPrefs(s.store.prefs)
  await new Promise((resolve) => setTimeout(resolve, 80))
  expect(s.store.job(id)).toMatchObject({ state: 'review', error: null })
  const proposal = await service.api.proposal(id)
  expect(proposal.revision).toBe(0)
  expect(proposal.memories).toHaveLength(1)
  await expect(
    service.api.review(
      id,
      { memories: [0], identities: {}, groups: [], descriptions: [] },
      proposal.revision,
    ),
  ).rejects.toThrow("This lane was deleted, so this review can't be refreshed. Reject it.")
  const update = vi.spyOn(s.store, 'updateJob')
  await service.api.setPrefs(s.store.prefs)
  await new Promise((resolve) => setTimeout(resolve, 80))
  expect(
    update.mock.calls.some(([, patch]) =>
      ['refreshing', 'running', 'failed'].includes(patch.state ?? ''),
    ),
  ).toBe(false)
  await expect(service.api.review(id, null, 0)).resolves.toMatchObject({ jobs: [] })
  expect(s.store.job(id)?.state).toBe('rejected')
  expect(s.runner).not.toHaveBeenCalled()
})

it('returns an interrupted refreshing job with a missing lane to review on startup', async () => {
  const s = await pipelineSetup()
  cleanups.push(s.cleanup)
  await extractJob(s.job, new AbortController().signal, s.store, s.options, s.search)
  const proposal = s.store.storedProposal(s.job.id)
  s.store.updateJob(s.job.id, { state: 'refreshing', runStartedAt: 123 })
  await unlink(s.file)
  s.store.rev++
  s.runner.mockClear()
  const service = await createBrainService(s.options)
  cleanups.push(() => service.dispose())
  await vi.waitFor(() =>
    expect(s.store.job(s.job.id)).toMatchObject({
      state: 'review',
      runStartedAt: null,
      error: null,
    }),
  )
  expect(s.store.storedProposal(s.job.id)).toBe(proposal)
  await expect(service.api.proposal(s.job.id)).resolves.toMatchObject({ revision: 0 })
  expect(s.runner).not.toHaveBeenCalled()
})
