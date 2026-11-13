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
    expect(launch!.env.PHOSPHOR_BRAIN_TOKEN).toBeTruthy()
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
      vector: new Float32Array([1, 0]),
    })
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
