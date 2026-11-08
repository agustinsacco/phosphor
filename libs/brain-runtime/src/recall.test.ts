import { expect, it, vi } from 'vitest'
import { createBrainClient } from '@phosphor/brain-client/client'
import { createNodeBrainTransport } from '@phosphor/brain-client/node-transport'
import { createRecall } from './recall'
import { FakeBrainStore } from './__fixtures__/fake-store'
import { HARBOR_RECALL } from '../../brain-client/src/__fixtures__/recall'
import { recallOptions } from './__fixtures__/options'

it('launches read-only recall only when enabled, sends session identity, and revokes on prefs changes', async () => {
  const store = new FakeBrainStore()
  const recall = createRecall(store, recallOptions(store))
  expect(await recall.recallLaunch()).toBeUndefined()
  store.prefs.enabled = true
  store.prefs.recall = false
  expect(await recall.recallLaunch()).toBeUndefined()
  store.prefs.recall = true
  store.recall = HARBOR_RECALL
  const launch = await recall.recallLaunch()
  expect(launch).toMatchObject({ extensions: ['/brain.mjs'], skills: ['/brain/SKILL.md'] })
  expect((await recall.recallLaunch())!.env).toEqual(launch!.env)
  const client = createBrainClient(
    createNodeBrainTransport({
      endpoint: launch!.env.PHOSPHOR_BRAIN_ENDPOINT!,
      token: launch!.env.PHOSPHOR_BRAIN_TOKEN!,
    }),
  )
  try {
    expect(
      await client.search({
        query: 'Who owns Harbor?',
        sessionId: 'tom-lane',
        cwd: '/projects/harbor',
      }),
    ).toEqual(HARBOR_RECALL)
    expect(store.deliveries).toEqual([{ sessionId: 'tom-lane', memoryIds: ['ownership'] }])
    store.prefs.recall = false
    expect(await client.related({ entity: 'Rina' })).toMatchObject({
      status: 'unavailable',
      hits: [],
    })
    expect(await recall.recallLaunch()).toBeUndefined()
  } finally {
    await recall.dispose()
  }
})

it('embeds search as a query, falls back to lexical, resolves related and records delivered ids only', async () => {
  const store = new FakeBrainStore()
  store.prefs.enabled = true
  store.recall = HARBOR_RECALL
  const options = recallOptions(store)
  const embed = vi.spyOn(options.embeddings, 'embed')
  const recall = createRecall(store, options)
  try {
    await recall.agent('search', {
      query: 'Harbor',
      cwd: '/projects/harbor',
      sessionId: 'rina-lane',
    })
    expect(embed).toHaveBeenCalledWith(['Harbor'], 'query')
    expect(store.searches[0]).toEqual({
      query: 'Harbor',
      vector: new Float32Array([1, 0]),
      limit: 6,
      scope: '/projects/harbor',
    })
    embed.mockRejectedValueOnce(new Error('Model unavailable'))
    await recall.agent('search', { query: 'Harbor', limit: 2 })
    expect(store.searches[1]).toMatchObject({ vector: null, limit: 2, scope: null })
    await recall.agent('related', {
      entity: 'Rina Okafor',
      cwd: '/projects/harbor',
      sessionId: 'tom-lane',
    })
    expect(store.relations).toEqual([
      { entity: 'Rina Okafor', limit: 12, scope: '/projects/harbor' },
    ])
    expect(store.deliveries).toEqual([
      { sessionId: 'rina-lane', memoryIds: ['ownership'] },
      { sessionId: 'tom-lane', memoryIds: ['ownership'] },
    ])
  } finally {
    await recall.dispose()
  }
})
