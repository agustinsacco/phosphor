import { expect, it, vi } from 'vitest'
import { HARBOR_RECALL } from '../../brain-client/src/__fixtures__/recall'
import type { BrainClient } from '@phosphor/brain-client/client'
import { registerBrain } from './brain'
import type { ToolDefinition } from './pi-api'

interface Context {
  cwd: string
  sessionManager: { getSessionId(): string; getSessionName(): string }
}
interface Flag {
  ref: number
  problem: 'wrong' | 'outdated' | 'duplicate'
  reason: string
}
const ctx = (id = 'harbor-lane'): Context => ({
  cwd: '/projects/harbor',
  sessionManager: { getSessionId: () => id, getSessionName: () => 'Harbor billing' },
})
function setup() {
  const tools = new Map<string, ToolDefinition<unknown, Context, unknown>>()
  const client: BrainClient = {
    search: vi.fn(async () => HARBOR_RECALL),
    flag: vi.fn(async () => ({
      status: 'filed' as const,
      message: 'Flag filed for the owner to review; Brain knowledge has not changed.',
    })),
  }
  registerBrain(
    {
      registerTool: (tool) => {
        tools.set(tool.name, tool as ToolDefinition<unknown, Context, unknown>)
      },
    },
    client,
  )
  const search = async (context = ctx()) =>
    tools.get('brain_search')!.execute('search', { query: 'Harbor' }, undefined, undefined, context)
  const flag = async (params: Flag, context = ctx()) =>
    tools.get('brain_flag')!.execute('flag', params, undefined, undefined, context)
  return { client, search, flag, tools }
}
const input: Flag = { ref: 1, problem: 'wrong', reason: 'Rina verified the billing rule changed.' }
it('files a known bracket number with lane identity and no knowledge change', async () => {
  const s = setup()
  await s.search()
  const result = await s.flag(input)
  expect(s.client.flag).toHaveBeenCalledWith(
    {
      memoryId: HARBOR_RECALL.hits[0]!.memory.id,
      problem: 'wrong',
      reason: input.reason,
      sessionId: 'harbor-lane',
      title: 'Harbor billing',
    },
    undefined,
  )
  expect(result.content[0]?.text).toContain('Brain knowledge has not changed')
})
it('refuses unknown numbers, another session and oversize or unknown fields plainly', async () => {
  const s = setup()
  expect((await s.flag(input)).content[0]?.text).toContain('search again')
  await s.search()
  expect((await s.flag({ ...input, ref: 2 })).content[0]?.text).toContain('search again')
  expect((await s.flag(input, ctx('ledger-lane'))).content[0]?.text).toContain('search again')
  expect((await s.flag({ ...input, reason: 'x'.repeat(301) })).content[0]?.text).toContain(
    '1 to 300',
  )
  expect((await s.flag({ ...input, extra: true } as Flag)).content[0]?.text).toContain('1 to 300')
  expect(s.client.flag).not.toHaveBeenCalled()
})
it('replaces the reference map on every search, including no match and failure', async () => {
  const s = setup()
  await s.search()
  vi.mocked(s.client.search).mockResolvedValueOnce({
    ...HARBOR_RECALL,
    status: 'no_match',
    hits: [],
  })
  await s.search()
  expect((await s.flag(input)).content[0]?.text).toContain('search again')
  await s.search()
  vi.mocked(s.client.search).mockRejectedValueOnce(new Error('Search unavailable'))
  await expect(s.search()).rejects.toThrow('Search unavailable')
  expect((await s.flag(input)).content[0]?.text).toContain('search again')
})
it.each(['already_flagged', 'limit'] as const)(
  'returns the server %s refusal without claiming success',
  async (status) => {
    const s = setup()
    await s.search()
    vi.mocked(s.client.flag).mockResolvedValueOnce({
      status,
      message:
        status === 'limit'
          ? 'This lane already has five open flags.'
          : 'This memory is already flagged.',
    })
    expect((await s.flag(input)).details).toEqual({ status })
  },
)
