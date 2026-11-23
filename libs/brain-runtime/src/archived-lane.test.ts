import { decideRead } from './__fixtures__/decide-read'
import { appendFile, rename } from 'node:fs/promises'
import { afterEach, expect, it, vi } from 'vitest'
import { createBrainService } from './service'
import { pipelineSetup } from './__fixtures__/pipeline'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close()
})
async function setup(ready = true) {
  const s = await pipelineSetup()
  cleanups.push(s.cleanup)
  s.store.jobs = []
  const status = s.options.embeddings.status()
  const embedding = vi.spyOn(s.options.embeddings, 'status').mockReturnValue({
    ...status,
    phase: ready ? 'ready' : 'missing',
  })
  const service = await createBrainService(s.options)
  cleanups.push(() => service.dispose())
  const id = (await service.api.queue({ sessionPath: s.file, title: 'Harbor' })).jobs[0]!.id
  if (ready) await vi.waitFor(() => expect(s.store.job(id)?.state).toBe('review'))
  s.runner.mockClear()
  return {
    ...s,
    service,
    id,
    archive: () => rename(s.file, `${s.file}.archived`),
    ready: () => embedding.mockReturnValue({ ...status, phase: 'ready' }),
  }
}

it('refreshes an archived lane review from saved steps without extract or links calls', async () => {
  const s = await setup()
  await s.archive()
  s.store.rev++
  // Brain Agent opens the stale review, which refreshes it.
  await s.service.agent('readReview', { jobId: s.id })
  expect(s.store.job(s.id)?.state).toBe('review')
  expect(s.store.storedProposal(s.id)?.computedRevision).toBe(1)
  expect(s.runner.mock.calls.filter(([call]) => ['extract', 'links'].includes(call.stage))).toEqual(
    [],
  )
  expect(s.runner).not.toHaveBeenCalled()
})

it('checks the current never-read title in an archived transcript, not the old job title', async () => {
  const s = await setup()
  await appendFile(s.file, '\n' + JSON.stringify({ type: 'session_info', name: 'Tom 1:1' }))
  await s.archive()
  s.store.rev++
  await s.service.api.setPrefs(s.store.prefs)
  await expect(s.service.api.proposal(s.id)).resolves.toMatchObject({ revision: 0 })
  await expect(
    decideRead(
      s.service,
      s.id,
      { memories: [0], identities: {}, groups: [], descriptions: [], confirmations: [] },
      0,
    ),
  ).rejects.toThrow('this lane is set to never be read')
  expect(s.store.job(s.id)?.state).toBe('review')
  expect(s.runner).not.toHaveBeenCalled()
})

it('reads a job queued before its lane was archived', async () => {
  const s = await setup(false)
  expect(s.store.job(s.id)?.state).toBe('queued')
  await s.archive()
  s.ready()
  await s.service.api.setPrefs(s.store.prefs)
  await vi.waitFor(() => expect(s.store.job(s.id)?.state).toBe('review'))
  expect(s.runner.mock.calls.filter(([call]) => call.stage === 'extract')).toHaveLength(1)
  expect(s.store.proposal(s.id).memories).toHaveLength(1)
})

it('prepares a new read of an archived lane and refuses its current excluded title', async () => {
  const s = await setup(false)
  await s.service.api.cancel(s.id)
  await s.archive()
  await expect(
    s.service.api.queue({ sessionPath: s.file, title: 'Harbor' }),
  ).resolves.toMatchObject({
    jobs: [expect.objectContaining({ state: 'queued' })],
  })
  await appendFile(
    `${s.file}.archived`,
    '\n' + JSON.stringify({ type: 'session_info', name: 'Tom 1:1' }),
  )
  await expect(s.service.api.queue({ sessionPath: s.file, title: 'Harbor' })).rejects.toThrow(
    'its title matches a rule',
  )
})

it('rebuilds the source and prompts of a read from its archived transcript', async () => {
  const s = await setup()
  const before = await s.service.api.extraction(s.id)
  await s.archive()
  const after = await s.service.api.extraction(s.id)
  expect(after.source).toEqual(before.source)
  expect(after.prompts).toEqual(before.prompts)
  expect(after.source.exists).toBe(true)
})
