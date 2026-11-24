import { describe, expect, it, vi } from 'vitest'
import { createBrainClient } from './client'
import type { BrainTransport } from './port'
import { HARBOR_RECALL } from './__fixtures__/recall'

function setup(result: unknown = HARBOR_RECALL) {
  const request = vi.fn<BrainTransport['request']>().mockResolvedValue(result as never)
  return { request, client: createBrainClient({ request }) }
}

describe('createBrainClient', () => {
  it('exposes search and flag, preserving session, cwd and cancellation', async () => {
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
    expect(Object.keys(client)).toEqual(['flag', 'search'])
  })

  it.each([
    {},
    null,
    { ...HARBOR_RECALL, hits: [{ memory: {} }] },
    { ...HARBOR_RECALL, status: 'partial' },
    { ...HARBOR_RECALL, entities: [{}] },
    { ...HARBOR_RECALL, focus: [1] },
    { ...HARBOR_RECALL, hits: [{ ...HARBOR_RECALL.hits[0], trail: { links: [] } }] },
    { ...HARBOR_RECALL, mode: undefined },
    { ...HARBOR_RECALL, branch: 3 },
    {
      ...HARBOR_RECALL,
      hits: [
        { ...HARBOR_RECALL.hits[0]!, memory: { ...HARBOR_RECALL.hits[0]!.memory, state: 'gone' } },
      ],
    },
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
          mode: 'search',
          more: 0,
          branch: null,
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

const flag = {
  memoryId: 'harbor-fact',
  problem: 'wrong' as const,
  reason: 'Rina verified the billing rule changed.',
  sessionId: 'harbor-lane',
  title: 'Harbor billing',
}
it('sends a validated flag and accepts bounded typed refusals', async () => {
  for (const status of ['filed', 'already_flagged', 'limit', 'unavailable']) {
    const result = { status, message: 'Brain knowledge has not changed.' }
    const { client, request } = setup(result)
    expect(await client.flag(flag)).toEqual(result)
    expect(request).toHaveBeenCalledWith('flag', flag, undefined)
  }
})
it.each([
  { reason: '' },
  { reason: ' '.repeat(2) },
  { reason: 'x'.repeat(301) },
  { memoryId: 'x'.repeat(201) },
  { sessionId: 'x'.repeat(257) },
  { title: 'x'.repeat(121) },
  { problem: 'guess' },
  { extra: 'not allowed' },
])('rejects invalid flag fields before transport %j', async (patch) => {
  const { client, request } = setup()
  await expect(client.flag({ ...flag, ...patch } as typeof flag)).rejects.toMatchObject({
    code: 'malformed',
  })
  expect(request).not.toHaveBeenCalled()
})
it.each([
  {},
  { status: 'changed', message: 'changed' },
  { status: 'filed', message: 'x'.repeat(301) },
  { status: 'filed', message: 'ok', extra: true },
])('rejects malformed flag responses %j', async (response) => {
  await expect(setup(response).client.flag(flag)).rejects.toMatchObject({ code: 'malformed' })
})
