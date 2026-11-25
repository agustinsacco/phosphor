import { afterEach, expect, it, vi } from 'vitest'
import { createRecall } from './recall'
import { projectContext } from './lane'
import type { BrainServiceOptions } from './types'
import { FakeBrainSearch } from './__fixtures__/fake-search'
import { DEFAULT_BRAIN_PREFS } from '@phosphor/shared/brain'
import { HARBOR_RECALL } from '../../brain-client/src/__fixtures__/recall'
import type { BrainEntitySummary } from '@phosphor/shared/brain-explore'
import { emptyExpansion, emptyRoutes } from './search/query'
import { FakeBrainStore } from './__fixtures__/fake-store'
import { recallOptions } from './__fixtures__/options'
function fixture() {
  const prefs = { ...DEFAULT_BRAIN_PREFS, enabled: false }
  const store = {
    snapshot: () => ({
      prefs,
      revision: 0,
      ownerId: null,
      generation: 'one',
      counts: { entities: 0, memories: 0 },
      readSessionIds: [],
      jobs: [],
    }),
    memory: vi.fn(),
    recordRecall: vi.fn(),
  }
  const search = new FakeBrainSearch()
  const options: BrainServiceOptions = {
    directory: '/brain',
    openStore: vi.fn(),
    openSearch: () => search,
    embeddings: {
      embed: vi.fn(async () => [[1, ...Array<number>(767).fill(0)]]),
      download: vi.fn(),
      dispose: vi.fn(),
      status: vi.fn(),
      remove: vi.fn(),
      setEnabled: vi.fn(),
    },
    lanes: { busy: vi.fn(), launch: vi.fn() },
    guardExtension: '/guard.mjs',
    recall: { extension: '/brain.mjs', skill: '/brain/SKILL.md' },
  }
  return { store, prefs, search, options }
}
vi.mock('./lane', () => ({
  projectContext: vi.fn(async () => ({ scope: '/harbor', branch: 'main' })),
}))
afterEach(() => vi.clearAllMocks())
it('enables and revokes read-only recall launch without allowing a disabled search', async () => {
  const { prefs, store, search, options } = fixture(),
    recall = createRecall(store, options, search)
  try {
    expect(await recall.recallLaunch()).toBeUndefined()
    expect((await recall.agent('search', { query: 'Harbor' })).status).toBe('unavailable')
    prefs.enabled = true
    const launch = await recall.recallLaunch()
    expect(launch).toMatchObject({ extensions: ['/brain.mjs'], skills: ['/brain/SKILL.md'] })
    expect(launch).not.toHaveProperty('env')
    prefs.recall = false
    expect(await recall.recallLaunch()).toBeUndefined()
  } finally {
    await recall.dispose()
  }
})
it('resolves scope and branch on each request, embeds query, falls back lexically and never writes deliveries', async () => {
  const { prefs, store, search, options } = fixture()
  prefs.enabled = true
  const recall = createRecall(store, options, search)
  try {
    await recall.agent('search', { query: 'Harbor', cwd: '/harbor', sessionId: 'lane' })
    expect(options.embeddings.embed).toHaveBeenCalledWith(['Harbor'], 'query')
    expect(search.searches[0]).toMatchObject({
      scope: '/harbor',
      branch: 'main',
      limit: 8,
      vector: expect.any(Float32Array),
    })
    expect(Array.from(search.searches[0]!.vector!.slice(0, 2))).toEqual([1, 0])
    expect(search.searches[0]!.vector).toHaveLength(768)
    vi.mocked(projectContext).mockResolvedValueOnce({ scope: '/harbor', branch: 'billing' })
    vi.mocked(options.embeddings.embed).mockRejectedValueOnce(new Error('Fake embedding failure'))
    await recall.agent('search', { query: 'Ledger', cwd: '/harbor' })
    expect(projectContext).toHaveBeenCalledTimes(2)
    expect(search.searches[1]).toMatchObject({ branch: 'billing', vector: null })
    expect(store.recordRecall).not.toHaveBeenCalled()
  } finally {
    await recall.dispose()
  }
})

it('asks the worker to rank names together, uses the top match, and counts only lane hits', async () => {
  const { prefs, store, search, options } = fixture()
  prefs.enabled = true
  const [rina, harbor] = HARBOR_RECALL.entities.map((e) => ({
    ...e,
    memories: 2,
    connections: 1,
  })) as [BrainEntitySummary, BrainEntitySummary]
  const alt = { ...rina, id: 'other' }
  const matches = vi.spyOn(search, 'resolve').mockResolvedValue([[rina, alt], [harbor]])
  const expansion = {
    ...emptyExpansion(),
    status: 'ok' as const,
    entity: rina,
    hits: HARBOR_RECALL.hits,
  }
  const expand = vi.spyOn(search, 'expand').mockResolvedValue(expansion)
  const route = vi.spyOn(search, 'routes').mockResolvedValue({
    ...emptyRoutes(),
    memories: [HARBOR_RECALL.hits[0]!.memory],
    from: rina,
    to: harbor,
    status: 'ok',
  })
  const curator = {
    search: vi.fn().mockResolvedValue(expansion),
    waiting: vi.fn(),
    suggestion: vi.fn(),
    entity: vi.fn(),
    memory: vi.fn(),
    resolve: vi.fn(),
    relate: vi.fn(),
    edit: vi.fn(),
    correct: vi.fn(),
    erase: vi.fn(),
    undo: vi.fn(),
  }
  const recall = createRecall(
    store,
    { ...options, now: () => 42 },
    search,
    () => true,
    undefined,
    curator,
  )
  expect(
    await recall.agent('search', { from: 'Rina', context: ['Harbor'], cwd: '/harbor' }),
  ).toEqual({ ...expansion, alternatives: [alt] })
  expect(matches).toHaveBeenCalledWith(['Rina', 'Harbor'])
  expect(expand).toHaveBeenCalledWith({
    entityId: rina.id,
    contextIds: [harbor.id],
    now: 42,
    limit: 8,
    scope: '/harbor',
    branch: 'main',
  })
  await recall.agent('search', { from: 'Rina', to: 'Harbor' })
  expect(route).toHaveBeenCalledWith(rina.id, harbor.id, 42)
  expect(options.embeddings.embed).not.toHaveBeenCalled()
  search.result = HARBOR_RECALL
  await recall.agent('search', { query: 'Harbor' })
  await recall.agent('search', { from: 'Rina' }, undefined, 'curator')
  expect(store.recordRecall.mock.calls).toEqual(Array(3).fill([['ownership'], 42]))
  await recall.dispose()
})
it('uses only owner facts and only the references shown in that lane’s latest briefing', async () => {
  const store = new FakeBrainStore(),
    search = new FakeBrainSearch()
  store.prefs.enabled = true
  const memory = HARBOR_RECALL.hits[0]!.memory
  search.result = HARBOR_RECALL
  store.details = [
    {
      memory,
      quotes: [],
      linkQuotes: {},
      entities: [],
      history: [],
      related: [],
      sourcePath: null,
      use: { recalled: 0, lastRecalledAt: null, flagged: 0 },
    },
  ]
  const flag = vi.spyOn(store, 'flag')
  const recall = createRecall(store, recallOptions(store), search, undefined, store)
  const lane = { cwd: '/projects/harbor', sessionId: 'owner-session', title: 'Owner title' }
  const one = recall.forLane(lane),
    other = recall.forLane({ ...lane, sessionId: 'other' })
  const spoofed = {
    cwd: '/untrusted',
    sessionId: 'forged',
    title: 'Untrusted',
    memoryId: 'forged-id',
  }
  const input = { ...spoofed, ref: 1, problem: 'wrong', reason: 'Verified.' }
  const query = { ...spoofed, query: 'Harbor' }
  try {
    expect(await one.search(query)).toMatchObject({
      text: expect.stringContaining('via Harbor, owned by Rina Okafor'),
      data: { status: 'ok', memories: 1 },
    })
    expect(projectContext).toHaveBeenCalledWith(lane.cwd)
    expect(await one.flag({ ...input, ref: 99 })).toMatchObject({
      data: { status: 'unavailable' },
    })
    expect(flag).not.toHaveBeenCalled()
    expect(await other.flag(input)).toMatchObject({ text: expect.stringContaining('search again') })
    expect(await one.flag(input)).toMatchObject({ data: { status: 'filed' } })
    expect(flag).toHaveBeenCalledWith({
      memoryId: memory.id,
      sessionId: lane.sessionId,
      title: lane.title,
      problem: 'wrong',
      reason: 'Verified.',
    })
    vi.spyOn(search, 'recall').mockRejectedValueOnce(new Error('Unavailable'))
    await expect(one.search(query)).rejects.toThrow('Unavailable')
    expect(await one.flag(input)).toMatchObject({ data: { status: 'unavailable' } })
    await one.search(query)
    search.result = { ...HARBOR_RECALL, status: 'no_match', hits: [] }
    await one.search(query)
    expect(await one.flag(input)).toMatchObject({ data: { status: 'unavailable' } })
    expect(flag).toHaveBeenCalledTimes(1)
  } finally {
    await recall.dispose()
  }
})
