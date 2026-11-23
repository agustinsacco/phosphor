import { decideRead } from './__fixtures__/decide-read'
import { mkdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createBrainService } from './service'
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
    (
      await s.service.api.setPrefs({
        neverRead: { titles: ['1:1', '1-1', 'one on one', '1on1'], sessionIds: [] },
        enabled: true,
        recall: false,
        review: true,
        model: null,
      })
    ).prefs.enabled,
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
  await decideRead(
    s.service,
    job.id,
    { descriptions: [], confirmations: [], memories: [0], identities: {}, groups: [] },
    p.revision,
  )
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
it('stale review requeues identity/reconcile from extract checkpoints instead of applying', async () => {
  const s = await setup()
  await s.service.api.queue({ sessionPath: s.file, title: 'Harbor' })
  await review(s.service)
  const job = (await s.service.api.status()).jobs[0]!
  s.store.rev++
  await expect(
    decideRead(
      s.service,
      job.id,
      { descriptions: [], confirmations: [], memories: [0], identities: {}, groups: [] },
      0,
    ),
  ).rejects.toThrow(
    'Brain refreshed this read since you read it. Read it again with brain_read_review, then decide.',
  )
  expect(s.store.reviews).toEqual([])
  await review(s.service)
  expect(s.runner.mock.calls.filter(([c]) => c.stage === 'extract')).toHaveLength(1)
  expect(s.store.storedProposal(job.id)!.computedRevision).toBe(1)
})
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
  await s.service.api.setPrefs({
    neverRead: { titles: ['1:1', '1-1', 'one on one', '1on1'], sessionIds: [] },
    enabled: true,
    recall: true,
    review: true,
    model: null,
  })
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

it('an unrelated knowledge change reuses every unchanged decision prompt', async () => {
  const s = await setup()
  await s.service.api.queue({ sessionPath: s.file, title: 'Harbor' })
  await review(s.service)
  const id = s.store.snapshot().jobs[0]!.id
  s.store.rev++
  // Brain Agent opens the stale review, which refreshes it.
  await s.service.agent('readReview', { jobId: id })
  expect(s.runner.mock.calls.filter(([call]) => call.stage === 'extract')).toHaveLength(1)
  expect(s.runner.mock.calls.filter(([call]) => call.stage === 'identity')).toHaveLength(1)
})

it('rereads a finished lane through busy waiting, rejects missing files and unfinished lanes', async () => {
  const s = await setup()
  await s.service.api.queue({ sessionPath: s.file, title: 'Harbor' })
  await review(s.service)
  const old = s.store.snapshot().jobs[0]!
  await decideRead(
    s.service,
    old.id,
    { descriptions: [], confirmations: [], memories: [0], identities: {}, groups: [] },
    s.store.rev,
  )
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
it('a lane flag reaches the engine through the agent entry', async () => {
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
})

it('approving one of three reviews leaves the other two to refresh when opened, without paying twice', async () => {
  const s = await setup()
  const ids: string[] = []
  for (const name of ['harbor', 'ledger', 'kestrel']) {
    const file = join(s.directory, `${name}.jsonl`)
    await writeFile(
      file,
      s.entries
        .map((e) => JSON.stringify(e.type === 'session' ? { ...e, id: name } : e))
        .join('\n'),
    )
    const status = await s.service.api.queue({ sessionPath: file, title: name })
    const id = status.jobs.at(-1)!.id
    await vi.waitFor(() => expect(s.store.job(id)?.state).toBe('review'))
    ids.push(id)
  }
  const starts = ids.map((id) => s.store.job(id)!.startedAt)
  s.runner.mockClear()
  const proposal = await s.service.api.proposal(ids[0]!)
  await decideRead(
    s.service,
    ids[0]!,
    { memories: [0], identities: {}, groups: [], descriptions: [], confirmations: [] },
    proposal.revision,
  )
  // They wait, stale, until Brain Agent opens them.
  for (const id of ids.slice(1)) {
    expect(s.store.job(id)?.state).toBe('review')
    expect(s.store.storedProposal(id)?.computedRevision).toBe(0)
    await s.service.agent('readReview', { jobId: id })
    expect(s.store.job(id)?.state).toBe('review')
    expect(s.store.storedProposal(id)?.computedRevision).toBe(1)
  }
  expect(s.runner).not.toHaveBeenCalled()
  expect(ids.map((id) => s.store.job(id)!.startedAt)).toEqual(starts)
})
it('changed identity candidate descriptions reach a new prompt while extraction stays cached', async () => {
  const s = await setup()
  s.store.matches = [[{ entityId: 'rina', channel: 'name', score: 1 }]]
  s.store.cards = [
    {
      id: 'rina',
      label: 'Rina Okafor',
      aliases: ['Rina'],
      kind: 'person',
      description: 'Harbor lead',
      neighbours: [],
      memories: 1,
    },
  ]
  await s.service.api.queue({ sessionPath: s.file, title: 'Harbor' })
  await review(s.service)
  const id = s.store.snapshot().jobs[0]!.id
  s.runner.mockClear()
  s.store.cards[0]!.description = 'Ledger lead'
  s.store.rev++
  await s.service.agent('readReview', { jobId: id })
  expect(s.runner).toHaveBeenCalledOnce()
  expect(s.runner.mock.calls[0]![0].stage).toBe('identity')
  expect(s.runner.mock.calls[0]![0].prompt).toContain('Ledger lead')
  expect(s.runner.mock.calls[0]![0].prompt).not.toContain('Harbor lead')
})
