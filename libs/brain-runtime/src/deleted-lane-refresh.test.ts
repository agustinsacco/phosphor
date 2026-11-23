import { decideRead } from './__fixtures__/decide-read'
import { unlinkSync } from 'node:fs'
import { unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
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
    decideRead(
      service,
      id,
      { memories: [0], identities: {}, groups: [], descriptions: [], confirmations: [] },
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
  await expect(decideRead(service, id, null, 0)).resolves.toMatchObject({ jobs: [] })
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

it('keeps the review if the transcript disappears after the queue checks it', async () => {
  const s = await pipelineSetup()
  cleanups.push(s.cleanup)
  await extractJob(s.job, new AbortController().signal, s.store, s.options, s.search)
  const proposal = s.store.storedProposal(s.job.id)
  s.store.rev++
  s.runner.mockClear()
  const part = s.store.part.bind(s.store)
  const preparing = vi.spyOn(s.store, 'part').mockImplementationOnce((...args) => {
    unlinkSync(s.file)
    return part(...args)
  })
  const service = await createBrainService(s.options)
  cleanups.push(() => service.dispose())
  // Brain Agent opens the stale review, which refreshes it.
  const opened = await service.agent('readReview', { jobId: s.job.id })
  expect(preparing).toHaveBeenCalled()
  expect(opened.text).toContain('Brain never reads this lane: reject it')
  expect(s.store.job(s.job.id)?.state).toBe('review')
  expect(s.store.storedProposal(s.job.id)).toBe(proposal)
  expect(s.runner).not.toHaveBeenCalled()
})

it('still reports an unrelated missing file as a failed refresh', async () => {
  const s = await pipelineSetup()
  cleanups.push(s.cleanup)
  await extractJob(s.job, new AbortController().signal, s.store, s.options, s.search)
  s.store.rev++
  s.runner.mockClear()
  vi.spyOn(s.options.embeddings, 'embed').mockRejectedValue(
    Object.assign(new Error('Missing embedding model file'), {
      code: 'ENOENT',
      path: '/made-up/model/config.json',
    }),
  )
  const service = await createBrainService(s.options)
  cleanups.push(() => service.dispose())
  await expect(service.agent('readReview', { jobId: s.job.id })).rejects.toThrow(
    'Missing embedding model file',
  )
  expect(s.store.job(s.job.id)).toMatchObject({
    state: 'failed',
    error: 'Missing embedding model file',
  })
  expect(s.runner).not.toHaveBeenCalled()
})

it('fails a queued read of a deleted lane with a plain sentence, not the archived path', async () => {
  const s = await pipelineSetup()
  cleanups.push(s.cleanup)
  s.store.jobs = []
  const ledger = join(s.directory, 'ledger.jsonl')
  await writeFile(
    ledger,
    s.entries
      .map((entry) => (entry.type === 'session' ? { ...entry, id: 'ledger-lane' } : entry))
      .map((entry) => JSON.stringify(entry))
      .join('\n'),
  )
  let release!: () => void
  const gate = new Promise<void>((resolve) => (release = resolve))
  const answer = s.runner.getMockImplementation()!
  s.runner.mockImplementationOnce(async (input) => {
    await gate
    return answer(input)
  })
  const service = await createBrainService(s.options)
  cleanups.push(() => service.dispose())
  const harbor = (await service.api.queue({ sessionPath: s.file, title: 'Harbor' })).jobs[0]!.id
  await vi.waitFor(() => expect(s.runner).toHaveBeenCalled())
  const status = await service.api.queue({ sessionPath: ledger, title: 'Ledger' })
  const id = status.jobs.find((job) => job.sessionId === 'ledger-lane')!.id
  expect(s.store.job(id)?.state).toBe('queued')
  await unlink(ledger)
  release()
  await vi.waitFor(() => expect(s.store.job(harbor)?.state).toBe('review'))
  await vi.waitFor(() =>
    expect(s.store.job(id)).toMatchObject({
      state: 'failed',
      error: "This lane was deleted, so Brain can't read it.",
    }),
  )
})
