import { afterEach, expect, it, vi } from 'vitest'
import { noOwnerReply, type OpReplyEnvelope } from '@phosphor/shared/ops'
import brainExtension, { registerBrain } from './brain'
import type { ToolDefinition } from './pi-api'

afterEach(() => vi.unstubAllEnvs())

it('only installs the two explicit tools on a marker lane; stale bridge env cannot enable them', () => {
  vi.stubEnv('PHOSPHOR_OPS', '')
  vi.stubEnv('PHOSPHOR_BRAIN_ENDPOINT', 'ignored')
  vi.stubEnv('PHOSPHOR_BRAIN_TOKEN', 'ignored')
  const pi = { registerTool: vi.fn(), on: vi.fn() }
  brainExtension(pi)
  expect(pi.registerTool).not.toHaveBeenCalled()
  vi.stubEnv('PHOSPHOR_OPS', 'v1')
  brainExtension(pi)
  expect(pi.registerTool.mock.calls.map(([tool]) => tool.name)).toEqual([
    'brain_search',
    'brain_flag',
  ])
  expect(pi.on).not.toHaveBeenCalled()
})

function setup() {
  const tools: ToolDefinition<{ query: string; limit?: number }, unknown, unknown>[] = []
  const send = vi.fn<Parameters<typeof registerBrain>[1]>()
  registerBrain({ registerTool: (tool) => tools.push(tool as (typeof tools)[number]) }, send)
  return { tool: tools[0]!, send }
}
it('sends only query and limit and returns the owner-formatted briefing', async () => {
  const { tool, send } = setup()
  const text = 'Path: Rina Okafor owns Harbor [1]'
  const data = { status: 'ok', memories: 1 }
  send.mockResolvedValue({ v: 1, id: '1', status: 'ok', applies: 'now', text, data })
  const ctx = { cwd: '/spoofed', sessionId: 'spoofed' }
  const signal = new AbortController().signal
  const params = { query: 'Harbor', limit: 2, ...ctx }
  expect(await tool.execute('one', params, signal, undefined, ctx)).toEqual({
    content: [{ type: 'text', text }],
    details: data,
  })
  expect(send).toHaveBeenCalledWith(
    ctx,
    { op: 'brain.search', args: { query: 'Harbor', limit: 2 } },
    { signal, deadlineMs: 10_000 },
  )
  expect(tool.description).toMatch(/person, team, system or ticket/)
})

it('reports a missing service, failed transport or unexpected confirmation as unavailable, not a no-match', async () => {
  const { tool, send } = setup()
  const responses: OpReplyEnvelope[] = [
    noOwnerReply(null),
    { v: 1, id: '2', status: 'denied', code: 'unavailable', text: 'Not connected.' },
    {
      v: 1,
      id: '3',
      status: 'confirm',
      confirmId: 'never',
      digest: 'never',
      title: 'never',
      message: 'never',
      timeoutMs: 1,
    },
  ]
  for (const response of responses) send.mockResolvedValueOnce(response)
  send.mockRejectedValueOnce(new Error('Disconnected'))
  for (let i = 0; i < responses.length + 1; i++) {
    expect(await tool.execute('one', { query: 'Harbor' }, undefined, undefined, {})).toEqual({
      content: [{ type: 'text', text: 'Brain is unavailable right now.' }],
      details: { status: 'unavailable', memories: 0 },
    })
  }
})
