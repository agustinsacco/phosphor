import { afterEach, expect, it, vi } from 'vitest'
import type { BrainClient } from '@phosphor/brain-client/client'
import { HARBOR_RECALL } from '../../brain-client/src/__fixtures__/recall'
import brainExtension, { registerBrain } from './brain'
import type { ToolDefinition } from './pi-api'

interface Context {
  cwd: string
  sessionManager: { getSessionId(): string }
}
interface Params {
  query: string
  limit?: number
}
afterEach(() => vi.unstubAllEnvs())

it('is inert without connection env and installs one explicit tool with no turn hooks', () => {
  vi.stubEnv('PHOSPHOR_BRAIN_ENDPOINT', '')
  vi.stubEnv('PHOSPHOR_BRAIN_TOKEN', '')
  const pi = { registerTool: vi.fn(), on: vi.fn() }
  brainExtension(pi)
  expect(pi.registerTool).not.toHaveBeenCalled()
  registerBrain(pi, { search: vi.fn() })
  expect(pi.registerTool.mock.calls.map(([tool]) => tool.name)).toEqual(['brain_search'])
  expect(pi.on).not.toHaveBeenCalled()
})

it('sends cwd and session identity and returns the formatted briefing without evidence', async () => {
  const tools: ToolDefinition<Params, Context, unknown>[] = []
  const client: BrainClient = { search: vi.fn(async () => HARBOR_RECALL) }
  registerBrain(
    { registerTool: (tool) => tools.push(tool as ToolDefinition<Params, Context, unknown>) },
    client,
  )
  const ctx = { cwd: '/projects/harbor', sessionManager: { getSessionId: () => 'harbor-lane' } }
  const signal = new AbortController().signal
  const search = await tools[0]!.execute(
    'one',
    { query: 'Who owns Harbor?', limit: 2 },
    signal,
    undefined,
    ctx,
  )
  expect(client.search).toHaveBeenCalledWith(
    { query: 'Who owns Harbor?', limit: 2, sessionId: 'harbor-lane', cwd: '/projects/harbor' },
    signal,
  )
  expect(search.content[0]).toMatchObject({
    type: 'text',
    text: expect.stringContaining('Links: Rina Okafor owns Harbor'),
  })
  expect(search.details).toEqual({ status: 'ok', memories: 1 })
  expect(tools[0]!.description).toMatch(/person, team, system or ticket/)
})

it('surfaces transport failures instead of inventing a no-match', async () => {
  const tools: ToolDefinition<Params, Context, unknown>[] = []
  const client: BrainClient = {
    search: vi.fn(async () => {
      throw new Error('Brain unavailable')
    }),
  }
  registerBrain(
    { registerTool: (tool) => tools.push(tool as ToolDefinition<Params, Context, unknown>) },
    client,
  )
  await expect(
    tools[0]!.execute('one', { query: 'Harbor' }, undefined, undefined, {
      cwd: '/projects/harbor',
      sessionManager: { getSessionId: () => 'lane' },
    }),
  ).rejects.toThrow('Brain unavailable')
})
