import { afterEach, expect, it, vi } from 'vitest'
import { createRecall } from './recall'
import { projectContext } from './lane'
import type { BrainServiceOptions } from './types'
import { FakeBrainSearch } from './__fixtures__/fake-search'
import { DEFAULT_BRAIN_PREFS } from '@phosphor/shared/brain'
import { HARBOR_RECALL } from '../../brain-client/src/__fixtures__/recall'
import type { BrainEntitySummary } from '@phosphor/shared/brain-explore'
import { emptyExpansion, emptyRoutes } from './search/query'
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
    expect(launch!.env.PHOSPHOR_BRAIN_TOKEN).toBeTruthy()
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
