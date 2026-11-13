import { mkdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createBrainService } from './service'
import { pipelineSetup } from './__fixtures__/pipeline'
import type { BrainService } from './types'
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f()
})
async function setup(enabled = true) {
  const s = await pipelineSetup()
  s.store.jobs = []
  s.store.prefs.enabled = enabled
  cleanup.push(s.cleanup)
  const service = await createBrainService(s.options)
  cleanup.push(() => service.dispose())
  return { ...s, service }
}
const review = async (service: BrainService) =>
  vi.waitFor(async () => expect((await service.api.status()).jobs[0]?.state).toBe('review'))
it('starts the injected reader/writer, saves prefs immediately, and awaits setup on disposal', async () => {
  const s = await setup(false)
  expect(await s.service.api.status()).toMatchObject({
    prefs: { enabled: false },
    generation: 'generation-1',
  })
  let finish!: () => void
  const set = vi.spyOn(s.options.embeddings, 'setEnabled').mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  expect(
    (await s.service.api.setPrefs({ enabled: true, recall: false, review: true })).prefs.enabled,
  ).toBe(true)
  expect(set).toHaveBeenCalledWith(true)
  finish()
  await s.service.dispose()
  expect(s.store.closed).toBe(true)
  expect(s.search.closed).toBe(true)
})
it('queues a lane, completes review, refreshes search and exposes bounded explorer APIs', async () => {
  const s = await setup()
  await s.service.api.queue({ sessionPath: s.file, title: 'Harbor' })
  await review(s.service)
  const job = (await s.service.api.status()).jobs[0]!,
    p = await s.service.api.proposal(job.id)
  expect(p.memories).toHaveLength(1)
  await s.service.api.review(job.id, { memories: [0], identities: {}, groups: [] }, p.revision)
  expect(s.search.refreshes).toBe(1)
  expect(await s.service.api.overview()).toMatchObject({ nodes: [], truncated: false })
  expect(await s.service.api.neighbourhood('harbor', 2)).toMatchObject({ centerId: 'harbor' })
  expect(await s.service.api.connections('harbor', 'owns', 'in', null)).toEqual({
    items: [],
    next: null,
  })
  expect(await s.service.api.entityMemories('harbor', {}, null)).toEqual({
    memories: [],
    entities: [],
    next: null,
  })
  expect(await s.service.api.find('Harbor', 10)).toMatchObject({ entities: [], memories: [] })
  expect(await s.service.api.path('harbor', 'ledger')).toEqual({
    paths: [],
    entities: [],
    memories: [],
  })
  await s.service.api.merge('a', 'b')
  await s.service.api.forget('missing')
  expect(s.search.refreshes).toBe(3)
})
it.each(['proposal', 'review'] as const)(
  'stale %s requeues identity/reconcile from extract checkpoints instead of applying',
  async (method) => {
    const s = await setup()
    await s.service.api.queue({ sessionPath: s.file, title: 'Harbor' })
    await review(s.service)
    const job = (await s.service.api.status()).jobs[0]!
    s.store.rev++
    await expect(
      method === 'proposal'
        ? s.service.api.proposal(job.id)
        : s.service.api.review(job.id, { memories: [0], identities: {}, groups: [] }, 0),
    ).rejects.toThrow('Brain changed; refreshing this review')
    expect(s.store.reviews).toEqual([])
    await review(s.service)
    expect(s.runner.mock.calls.filter(([c]) => c.stage === 'extract')).toHaveLength(1)
    expect(s.store.storedProposal(job.id)!.computedRevision).toBe(1)
  },
)
it('failed jobs retry the same id and resume validated parts', async () => {
  const s = await setup()
  s.runner.mockRejectedValueOnce(new Error('Fake failure'))
  await s.service.api.queue({ sessionPath: s.file, title: 'Harbor' })
  await vi.waitFor(() => expect(s.store.snapshot().jobs[0]?.state).toBe('failed'))
  const id = s.store.snapshot().jobs[0]!.id
  await s.service.api.retry(id)
  await review(s.service)
  expect(s.store.snapshot().jobs[0]!.id).toBe(id)
})
it('reset awaits cancellation, removes calls and legacy forks, refreshes generation and preserves the model', async () => {
  const s = await setup()
  for (const name of ['calls', 'forks', 'embeddings']) {
    await mkdir(join(s.directory, name))
    await writeFile(join(s.directory, name, 'test'), 'fake')
  }
  await s.service.api.queue({ sessionPath: s.file, title: 'Harbor' })
  await review(s.service)
  const status = await s.service.api.reset()
  expect(status.jobs).toEqual([])
  expect(status.generation).toBe('generation-1-reset')
  expect(status.prefs.review).toBe(true)
  for (const name of ['calls', 'forks'])
    expect(await stat(join(s.directory, name)).catch(() => null)).toBeNull()
  expect(await stat(join(s.directory, 'embeddings'))).toBeTruthy()
  expect(s.search.refreshes).toBe(1)
})
it('supports download retry and removal only while off; disabled startup leaves interrupted work queued', async () => {
  const s = await setup(false),
    download = vi.spyOn(s.options.embeddings, 'download'),
    remove = vi.spyOn(s.options.embeddings, 'remove')
  await s.service.api.download()
  expect(download).toHaveBeenCalledOnce()
  await s.service.api.removeModel()
  expect(remove).toHaveBeenCalledOnce()
  await s.service.api.setPrefs({ enabled: true, recall: true, review: true })
  await expect(s.service.api.removeModel()).rejects.toThrow('Turn off Brain')
})
it('deletes only the obsolete prototype artifacts on startup', async () => {
  const s = await pipelineSetup()
  cleanup.push(s.cleanup)
  s.store.jobs = []
  await writeFile(join(s.directory, 'memory.sqlite'), 'old')
  await mkdir(join(s.directory, 'sessions'))
  await mkdir(join(s.directory, 'embeddings'))
  const service = await createBrainService(s.options)
  cleanup.push(() => service.dispose())
  expect(await stat(join(s.directory, 'memory.sqlite')).catch(() => null)).toBeNull()
  expect(await stat(join(s.directory, 'sessions')).catch(() => null)).toBeNull()
  expect(await stat(join(s.directory, 'embeddings'))).toBeTruthy()
})
