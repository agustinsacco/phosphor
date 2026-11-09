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
  query?: string
  entity?: string
  limit?: number
}
afterEach(() => vi.unstubAllEnvs())

it('is inert without connection env and installs two explicit tools with no turn hooks', () => {
  vi.stubEnv('PHOSPHOR_BRAIN_ENDPOINT', '')
  vi.stubEnv('PHOSPHOR_BRAIN_TOKEN', '')
  const pi = { registerTool: vi.fn(), on: vi.fn() }
  brainExtension(pi)
  expect(pi.registerTool).not.toHaveBeenCalled()
  registerBrain(pi, { search: vi.fn(), related: vi.fn() })
  expect(pi.registerTool.mock.calls.map(([tool]) => tool.name)).toEqual([
    'brain_search',
    'brain_related',
  ])
  expect(pi.on).not.toHaveBeenCalled()
})

it('tools send cwd and session identity and format approved sentences without evidence', async () => {
  const tools: ToolDefinition<Params, Context, unknown>[] = []
  const client: BrainClient = {
    search: vi.fn(async () => HARBOR_RECALL),
    related: vi.fn(async () => HARBOR_RECALL),
  }
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
  const related = await tools[1]!.execute('two', { entity: 'Rina Okafor' }, signal, undefined, ctx)
  expect(client.search).toHaveBeenCalledWith(
    { query: 'Who owns Harbor?', limit: 2, sessionId: 'harbor-lane', cwd: '/projects/harbor' },
    signal,
  )
  expect(client.related).toHaveBeenCalledWith(
    { entity: 'Rina Okafor', sessionId: 'harbor-lane', cwd: '/projects/harbor' },
    signal,
  )
  expect(search.content[0]).toMatchObject({
    type: 'text',
    text: expect.stringContaining(
      '[fact] Rina Okafor owns Harbor billing. · harbor (this project) · 2026-11-06',
    ),
  })
  expect(related.details).toEqual({ status: 'ok', memories: 1 })
})

it('surfaces transport failures instead of inventing a no-match', async () => {
  const tools: ToolDefinition<Params, Context, unknown>[] = []
  const client: BrainClient = {
    search: vi.fn(async () => {
      throw new Error('Brain unavailable')
    }),
    related: vi.fn(),
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
