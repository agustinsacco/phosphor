import { HARBOR_RECALL } from '../../brain-client/src/__fixtures__/recall'

import { afterEach, expect, it, vi } from 'vitest'
import { createRecall } from './recall'
import { projectContext } from './lane'
import { FakeBrainStore, FakeBrainSearch } from './__fixtures__/fake-store'
import { recallOptions } from './__fixtures__/options'
vi.mock('./lane', () => ({
  projectContext: vi.fn(async () => ({ scope: '/harbor', branch: 'main' })),
}))
afterEach(() => vi.clearAllMocks())
it('enables and revokes read-only recall launch without allowing a disabled search', async () => {
  const store = new FakeBrainStore(),
    search = new FakeBrainSearch(),
    options = recallOptions(store),
    recall = createRecall(store, options, search)
  try {
    expect(await recall.recallLaunch()).toBeUndefined()
    expect((await recall.agent('search', { query: 'Harbor' })).status).toBe('unavailable')
    store.prefs.enabled = true
    const launch = await recall.recallLaunch()
    expect(launch).toMatchObject({ extensions: ['/brain.mjs'], skills: ['/brain/SKILL.md'] })
    expect(launch).not.toHaveProperty('env')
    store.prefs.recall = false
    expect(await recall.recallLaunch()).toBeUndefined()
  } finally {
    await recall.dispose()
  }
})
it('resolves scope and branch on each request, embeds query, falls back lexically and never writes deliveries', async () => {
  const store = new FakeBrainStore(),
    search = new FakeBrainSearch(),
    options = recallOptions(store)
  store.prefs.enabled = true
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
    expect(store.rev).toBe(0)
    expect(store.jobs).toEqual([])
  } finally {
    await recall.dispose()
  }
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
      text: expect.stringContaining('Path: Rina Okafor owns Harbor [1]'),
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
