import { mkdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createBrainService } from './service'
import { pipelineSetup } from './__fixtures__/pipeline'
import type { BrainMemoryDetail } from '@phosphor/shared/brain-explore'
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
        agentAuto: true,
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
it('queues a lane, saves automatically, refreshes search and exposes bounded explorer APIs', async () => {
  const s = await setup()
  await s.service.api.queue({ sessionPath: s.file, title: 'Harbor' })
  await vi.waitFor(() => expect(s.store.jobs[0]?.state).toBe('done'))
  expect(s.search.refreshes).toBe(1)
  expect(await s.service.api.overview()).toMatchObject({ nodes: [], truncated: false })
  expect(await s.service.api.neighbourhood('harbor', 2)).toMatchObject({ centerId: 'harbor' })
  expect(await s.service.api.entityMemories('harbor', {}, null)).toEqual({
    memories: [],
    entities: [],
    next: null,
  })
  expect(await s.service.api.find('Harbor', 10)).toMatchObject({ entities: [], memories: [] })
  expect(await s.service.api.ask('Harbor')).toEqual(s.search.result)
  expect(s.search.searches.at(-1)).toMatchObject({ limit: 8, scope: null, branch: null })
  expect(await s.service.api.path('harbor', 'ledger')).toEqual({
    mode: 'route',
    status: 'no_match',
    from: null,
    to: null,
    routes: [],
    entities: [],
    memories: [],
  })
  await s.service.api.merge('a', 'b', (await s.service.api.status()).revision)
  await s.service.api.forget('missing')
  expect(s.search.refreshes).toBe(3)
})
it('tells Brain Agent without starting a run, and exposes the selected owner and newest lane read', async () => {
  const s = await setup()
  const tell = vi.fn(async () => ({ sessionPath: 'harbor-lane' }))
  s.options.agent = { folder: s.directory, turn: vi.fn(), tell }
  await expect(s.service.api.tell('Merge the Ledger records')).resolves.toEqual({
    sessionPath: 'harbor-lane',
  })
  expect(tell).toHaveBeenCalledWith('Merge the Ledger records')
  expect(s.store.latestRun()).toBeNull()
  await expect(s.service.api.setOwner('rina')).resolves.toMatchObject({ ownerId: 'rina' })
  await expect(s.service.api.setOwner(null)).resolves.toMatchObject({ ownerId: null })
  await expect(s.service.api.laneRead('harbor-lane')).resolves.toBeNull()
})
it('failed jobs retry the same id and resume validated parts', async () => {
  const s = await setup()
  s.runner.mockRejectedValueOnce(new Error('Fake failure'))
  await s.service.api.queue({ sessionPath: s.file, title: 'Harbor' })
  await vi.waitFor(() => expect(s.store.snapshot().jobs[0]?.state).toBe('failed'))
  const id = s.store.snapshot().jobs[0]!.id
  await s.service.api.retry(id)
  await vi.waitFor(() => expect(s.store.jobs[0]?.state).toBe('done'))
  expect(s.store.jobs[0]!.id).toBe(id)
})
it('reset awaits cancellation, removes calls and legacy forks, refreshes generation and preserves the model', async () => {
  const s = await setup()
  for (const name of ['calls', 'forks', 'embeddings']) {
    await mkdir(join(s.directory, name))
    await writeFile(join(s.directory, name, 'test'), 'fake')
  }
  await s.service.api.queue({ sessionPath: s.file, title: 'Harbor' })
  await vi.waitFor(() => expect(s.store.jobs[0]?.state).toBe('done'))
  const status = await s.service.api.reset()
  expect(status.jobs).toEqual([])
  expect(status.generation).toBe('generation-1-reset')
  expect(status.prefs.agentAuto).toBe(true)
  for (const name of ['calls', 'forks'])
    expect(await stat(join(s.directory, name)).catch(() => null)).toBeNull()
  expect(await stat(join(s.directory, 'embeddings'))).toBeTruthy()
  expect(s.search.refreshes).toBe(2)
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
    agentAuto: true,
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

it('rereads a finished lane through busy waiting, rejects missing files and unfinished lanes', async () => {
  const s = await setup()
  await s.service.api.queue({ sessionPath: s.file, title: 'Harbor' })
  await vi.waitFor(() => expect(s.store.jobs[0]?.state).toBe('done'))
  const old = s.store.jobs[0]!
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
