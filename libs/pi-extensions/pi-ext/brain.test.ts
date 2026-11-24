import { afterEach, expect, it, vi } from 'vitest'
import {
  noOwnerReply,
  OP_MARKER_ENV,
  OP_MARKER_VALUE,
  OP_TITLE,
  parseOpChannelRequest,
  type OpReplyEnvelope,
} from '@phosphor/shared/ops'
import brainExtension, { registerBrain } from './brain'
import type { ToolDefinition } from './pi-api'

afterEach(() => vi.unstubAllEnvs())

it('only installs the two explicit tools on a marker lane; stale bridge env cannot enable them', () => {
  vi.stubEnv(OP_MARKER_ENV, '')
  vi.stubEnv('PHOSPHOR_BRAIN_ENDPOINT', 'ignored')
  vi.stubEnv('PHOSPHOR_BRAIN_TOKEN', 'ignored')
  const pi = { registerTool: vi.fn(), on: vi.fn() }
  brainExtension(pi)
  expect(pi.registerTool).not.toHaveBeenCalled()
  vi.stubEnv(OP_MARKER_ENV, OP_MARKER_VALUE)
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
  expect(tool.description).toMatch(/from and to/)
})
it('sends a name to expand with its context, and a route, as the same op', async () => {
  const { tool, send } = setup()
  send.mockResolvedValue({ v: 1, id: '1', status: 'ok', applies: 'now', text: 'x', data: {} })
  const signal = new AbortController().signal
  const moves = [
    { from: 'Rina Okafor', context: ['Harbor'] },
    { from: 'Rina Okafor', to: 'Tom Lee', limit: 3 },
  ]
  for (const move of moves)
    await tool.execute('one', move as unknown as { query: string }, signal, undefined, {})
  expect(send.mock.calls.map(([, request]) => request)).toEqual(
    moves.map((args) => ({ op: 'brain.search', args })),
  )
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

it('uses the lane editor sender for recall when loaded with no injected transport', async () => {
  vi.stubEnv(OP_MARKER_ENV, OP_MARKER_VALUE)
  const tools = new Map<string, ToolDefinition<{ query: string }, unknown, unknown>>()
  brainExtension({
    registerTool: (tool) =>
      tools.set(tool.name, tool as ToolDefinition<{ query: string }, unknown, unknown>),
  })
  const data = { status: 'ok', memories: 1 }
  const editor = vi.fn(async (_title: string, prefill: string) => {
    const request = parseOpChannelRequest(prefill)
    return JSON.stringify({
      v: 1,
      id: request?.id,
      status: 'ok',
      applies: 'now',
      text: 'A recalled note',
      data,
    })
  })
  const result = await tools
    .get('brain_search')!
    .execute('search', { query: 'Harbor' }, undefined, undefined, { ui: { editor } })
  expect(result).toEqual({ content: [{ type: 'text', text: 'A recalled note' }], details: data })
  const [title, prefill] = editor.mock.calls[0]!
  expect(title).toBe(OP_TITLE)
  expect(parseOpChannelRequest(prefill)).toMatchObject({
    op: 'brain.search',
    input: { query: 'Harbor' },
    deadlineMs: 10_000,
  })
})

it('sends a flag with its reason in the request envelope, where the owner audits it', async () => {
  const tools: ToolDefinition<Record<string, unknown>, unknown, unknown>[] = []
  const send = vi.fn<Parameters<typeof registerBrain>[1]>()
  registerBrain({ registerTool: (tool) => tools.push(tool as (typeof tools)[number]) }, send)
  const flag = tools.find((tool) => tool.name === 'brain_flag')!
  send.mockResolvedValue({
    v: 1,
    id: '1',
    status: 'ok',
    applies: 'now',
    text: 'Flagged',
    data: { status: 'ok' },
  })
  const signal = new AbortController().signal
  await flag.execute(
    'f',
    { ref: 2, problem: 'outdated', reason: 'Owner left' },
    signal,
    undefined,
    {},
  )
  expect(send).toHaveBeenCalledWith(
    {},
    {
      op: 'brain.flag',
      args: { ref: 2, problem: 'outdated', reason: 'Owner left' },
      reason: 'Owner left',
    },
    { signal, deadlineMs: 10_000 },
  )
})
