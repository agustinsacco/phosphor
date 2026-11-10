import { describe, expect, it, vi } from 'vitest'
import { createBrainClient } from './client'
import type { BrainTransport } from './port'
import { HARBOR_RECALL } from './__fixtures__/recall'

function setup(result: unknown = HARBOR_RECALL) {
  const request = vi.fn<BrainTransport['request']>().mockResolvedValue(result as never)
  return { request, client: createBrainClient({ request }) }
}

describe('createBrainClient', () => {
  it('exposes only search, preserving session, cwd and cancellation', async () => {
    const { client, request } = setup()
    const signal = new AbortController().signal
    const query = {
      query: 'Harbor billing',
      limit: 3,
      sessionId: 'harbor-lane',
      cwd: '/projects/harbor',
    }
    expect(await client.search(query, signal)).toEqual(HARBOR_RECALL)
    expect(request.mock.calls).toEqual([['search', query, signal]])
    expect(Object.keys(client)).toEqual(['search'])
  })

  it.each([
    {},
    null,
    { ...HARBOR_RECALL, hits: [{ memory: {} }] },
    { ...HARBOR_RECALL, status: 'partial' },
    { ...HARBOR_RECALL, entities: [{}] },
    { ...HARBOR_RECALL, focus: [1] },
    { ...HARBOR_RECALL, links: [{ subjectId: 'rina', predicate: 'likes', objectId: 'harbor' }] },
    { ...HARBOR_RECALL, more: -1 },
    { ...HARBOR_RECALL, more: undefined },
  ])('rejects malformed results %j', async (result) => {
    await expect(setup(result).client.search({ query: 'Harbor' })).rejects.toMatchObject({
      code: 'malformed',
    })
  })

  it('accepts no-match and unavailable without confusing them', async () => {
    for (const status of ['no_match', 'unavailable'] as const)
      expect(
        await setup({
          status,
          hits: [],
          entities: [],
          focus: [],
          links: [],
          more: 0,
          degradation: [],
        }).client.search({
          query: 'Harbor',
        }),
      ).toMatchObject({ status })
  })

  it.each([
    { query: '' },
    { query: 'Harbor', limit: 0 },
    { query: 'Harbor', limit: 21 },
    { query: 'Harbor', limit: 1.5 },
    { query: 'Harbor', cwd: '\0' },
    { query: 'Harbor', sessionId: '' },
  ])('rejects invalid requests before transport %j', async (query) => {
    const { client, request } = setup()
    await expect(client.search(query)).rejects.toMatchObject({ code: 'malformed' })
    expect(request).not.toHaveBeenCalled()
  })
})
