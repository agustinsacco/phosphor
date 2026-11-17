import { mkdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createBrainService } from './service'
import { NO_MODEL } from './tidy/check'
import { pipelineSetup } from './__fixtures__/pipeline'
import type { BrainMemoryDetail } from '@phosphor/shared/brain-explore'
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
    (await s.service.api.setPrefs({ enabled: true, recall: false, review: true, model: null }))
      .prefs.enabled,
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
  await s.service.api.merge('a', 'b', (await s.service.api.status()).revision)
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
  await s.service.api.setPrefs({ enabled: true, recall: true, review: true, model: null })
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

it('reset stops admission and waits for an active cancelled call before clearing the store', async () => {
  const s = await setup()
  let exited = false
  s.runner.mockImplementation(
    (input) =>
      new Promise((resolve) => {
        input.signal.addEventListener(
          'abort',
          () => {
            setTimeout(() => {
              exited = true
              resolve({ text: '{}', usage: { tokens: 0, cost: 0 } })
            }, 20)
          },
          { once: true },
        )
      }),
  )
  await s.service.api.queue({ sessionPath: s.file, title: 'Harbor' })
  await vi.waitFor(() => expect(s.runner).toHaveBeenCalledOnce())
  const pending = s.service.api.reset()
  await expect(s.service.api.queue({ sessionPath: s.file, title: 'Ledger' })).rejects.toThrow(
    'resetting',
  )
  expect(exited).toBe(false)
  expect((await pending).jobs).toEqual([])
  expect(exited).toBe(true)
  expect(s.search.refreshes).toBe(1)
})

it('stale review recomputation reuses extract parts and refreshes identity decisions', async () => {
  const s = await setup()
  await s.service.api.queue({ sessionPath: s.file, title: 'Harbor' })
  await review(s.service)
  const id = s.store.snapshot().jobs[0]!.id
  s.store.rev++
  await expect(s.service.api.proposal(id)).rejects.toThrow('refreshing this review')
  await review(s.service)
  expect(s.runner.mock.calls.filter(([call]) => call.stage === 'extract')).toHaveLength(1)
  expect(s.runner.mock.calls.filter(([call]) => call.stage === 'identity')).toHaveLength(2)
})

it('rereads a finished lane through busy waiting, rejects missing files and unfinished lanes', async () => {
  const s = await setup()
  await s.service.api.queue({ sessionPath: s.file, title: 'Harbor' })
  await review(s.service)
  const old = s.store.snapshot().jobs[0]!
  await s.service.api.review(old.id, { memories: [0], identities: {}, groups: [] }, s.store.rev)
  expect(s.service.api.reread).toBeTypeOf('function')
  vi.spyOn(s.options.lanes, 'busy').mockReturnValue(true)
  const result = await s.service.api.reread(old.id)
  expect(result.jobs[0]).toMatchObject({ replaces: old.id, state: 'waiting' })
  await expect(s.service.api.reread(old.id)).rejects.toThrow('This lane is already queued.')
  await s.service.api.cancel(result.jobs[0]!.id)
  await import('node:fs/promises').then((fs) => fs.unlink(s.file))
  await expect(s.service.api.reread(old.id)).rejects.toThrow(
    "This lane's file is gone, so Brain cannot read it again.",
  )
})
it('binds Tidy to the store: a run persists its progress and a lane flag reaches the engine', async () => {
  const s = await setup()
  s.store.prefs.recall = true
  s.store.details.push({ memory: { id: 'm1', state: 'active' } } as BrainMemoryDetail)
  const flagged = vi.spyOn(s.store, 'flag')
  expect(
    await s.service.agent('flag', {
      memoryId: 'm1',
      problem: 'wrong',
      reason: 'Tom Lee said Harbor bills monthly.',
      sessionId: 'lane-1',
      title: 'Harbor billing',
    }),
  ).toMatchObject({ status: 'filed' })
  expect(flagged).toHaveBeenCalledOnce()
  await s.service.api.tidyRun()
  // No read has finished in this fake store, so the model check is skipped with its reason.
  await vi.waitFor(() => expect(s.store.readRun()?.state).toBe('skipped'))
  expect((await s.service.api.tidy(null, null, 20)).run).toMatchObject({
    state: 'skipped',
    message: NO_MODEL,
  })
})
