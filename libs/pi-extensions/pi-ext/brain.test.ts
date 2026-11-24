import { spawnSync } from 'node:child_process'
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
afterEach(() => {
  vi.unstubAllEnvs()
  delete (globalThis as Record<symbol, unknown>)[Symbol.for('phosphor/brain-connection/v1')]
})

it('leaves no token or endpoint for a bash child of the lane, and survives a reload', async () => {
  vi.stubEnv('PHOSPHOR_BRAIN_ENDPOINT', '/tmp/harbor-brain.sock')
  vi.stubEnv('PHOSPHOR_BRAIN_TOKEN', 'harbor-lane-token')
  const pi = { registerTool: vi.fn(), on: vi.fn() }
  brainExtension(pi)
  expect(pi.registerTool).toHaveBeenCalledTimes(2)
  const child = spawnSync(
    'sh',
    ['-c', 'printf "%s|%s" "$PHOSPHOR_BRAIN_TOKEN" "$PHOSPHOR_BRAIN_ENDPOINT"'],
    { encoding: 'utf8' },
  )
  expect(child.stdout).toBe('|')
  // pi reloads an extension by evaluating its module again, in the same process.
  vi.resetModules()
  const { default: reloaded } = await import('./brain')
  const again = { registerTool: vi.fn(), on: vi.fn() }
  reloaded(again)
  expect(again.registerTool).toHaveBeenCalledTimes(2)
})

it('is inert without connection env and installs two explicit tools with no turn hooks', () => {
  vi.stubEnv('PHOSPHOR_BRAIN_ENDPOINT', '')
  vi.stubEnv('PHOSPHOR_BRAIN_TOKEN', '')
  const pi = { registerTool: vi.fn(), on: vi.fn() }
  brainExtension(pi)
  expect(pi.registerTool).not.toHaveBeenCalled()
  registerBrain(pi, { search: vi.fn(), flag: vi.fn() })
  expect(pi.registerTool.mock.calls.map(([tool]) => tool.name)).toEqual([
    'brain_search',
    'brain_flag',
  ])
  expect(pi.on).not.toHaveBeenCalled()
})

it('sends cwd and session identity and returns the formatted briefing without evidence', async () => {
  const tools: ToolDefinition<Params, Context, unknown>[] = []
  const client: BrainClient = { search: vi.fn(async () => HARBOR_RECALL), flag: vi.fn() }
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
    text: expect.stringContaining('via Harbor, owned by Rina Okafor'),
  })
  expect(search.details).toEqual({ status: 'ok', memories: 1 })
  expect(tools[0]!.description).toMatch(/from and to/)
})

it('surfaces transport failures instead of inventing a no-match', async () => {
  const tools: ToolDefinition<Params, Context, unknown>[] = []
  const client: BrainClient = {
    flag: vi.fn(),
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
