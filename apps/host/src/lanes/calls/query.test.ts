import { afterEach, describe, expect, it, vi } from 'vitest'
import { HOST_LIMITS } from '@phosphor/shared/host-protocol'
import type { AgentMessage, RpcResponse, RpcSessionState } from '@phosphor/shared/rpc'
import { PI_MESSAGES_MAX } from '../pi-results'
import type { StoredLane } from '../store'
import {
  laneQueryCapability,
  requestLiveQuery,
  resolveLaneQuery,
  stoppedQuery,
  type LaneQueryOptions,
} from './query'
import { ExportTooLarge } from '../../session/html-export'

const lane: StoredLane = {
  laneId: '00000000-0000-4000-8000-000000000001',
  repositoryId: '0000000000000000',
  cwd: '/repo',
  sessionFile: null,
  removedAt: null,
  title: null,
  branch: 'feature',
  worktree: true,
  model: null,
  activity: 'idle',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  attention: 0,
  read: 0,
  control: { fence: 1, controller: null },
}
const state: RpcSessionState = {
  sessionId: 'pi-id',
  thinkingLevel: 'off',
  isStreaming: false,
  isCompacting: false,
  steeringMode: 'all',
  followUpMode: 'all',
  autoCompactionEnabled: true,
  messageCount: 0,
  pendingMessageCount: 0,
}
const stats = {
  userMessages: 0,
  assistantMessages: 0,
  toolCalls: 0,
  toolResults: 0,
  totalMessages: 0,
  cost: 0,
  tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}
const messages: AgentMessage[] = [
  { role: 'user', content: 'task', timestamp: 10 },
  {
    role: 'assistant',
    content: [
      {
        type: 'toolCall',
        id: 'one',
        name: 'write',
        arguments: { path: 'a.ts', content: 'x' },
      },
      {
        type: 'toolCall',
        id: 'two',
        name: 'write',
        arguments: { path: '/repo/a.ts', content: 'y' },
      },
    ],
    stopReason: 'toolUse',
    timestamp: 15,
  },
  {
    role: 'toolResult',
    toolCallId: 'one',
    toolName: 'write',
    content: [],
    isError: false,
    timestamp: 16,
  },
  {
    role: 'toolResult',
    toolCallId: 'two',
    toolName: 'write',
    content: [],
    isError: false,
    timestamp: 17,
  },
  {
    role: 'assistant',
    content: [{ type: 'text', text: 'Done' }],
    stopReason: 'stop',
    timestamp: 20,
  },
]
const internal = {
  ok: false,
  error: { code: 'internal', message: 'the lane query could not complete' },
}
const receipt = vi.fn(() => ({ ok: true as const, data: 'receipt' }))
function fixture() {
  const command = vi.fn<LaneQueryOptions['runtime']['command']>()
  const options: LaneQueryOptions = {
    store: { getLane: () => lane, listRepositories: () => [] },
    live: { sessionFor: () => 'runtime-id' },
    runtime: { command },
    unattached: () => null,
    now: Date.now,
    log: vi.fn(),
  }
  return { options, command }
}
afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('resolveLaneQuery', () => {
  it('keeps the exact allowlist, parameter validation and removed lane checks', async () => {
    const { options, command } = fixture()
    for (const method of [
      'host.repositories',
      'lane.state',
      'lane.messages',
      'lane.receipt',
      'lane.stats',
      'lane.models',
      'lane.commands',
    ])
      expect(laneQueryCapability(method)).toBe('sessions.read')
    for (const method of ['lane.State', 'lane.messages.extra', 'get_messages']) {
      expect(laneQueryCapability(method)).toBeNull()
      expect(await resolveLaneQuery(options, method, null)).toMatchObject({
        error: { code: 'unsupported' },
      })
    }
    for (const params of [null, undefined, [], 'text', 1])
      expect(await resolveLaneQuery(options, 'host.repositories', params)).toMatchObject({
        error: { code: 'bad-request' },
      })
    expect(await resolveLaneQuery(options, 'host.repositories', {})).toEqual({ ok: true, data: [] })
    for (const params of [{}, { laneId: 1 }, { laneId: 'bad' }])
      expect(await resolveLaneQuery(options, 'lane.state', params)).toMatchObject({
        error: { code: 'bad-request' },
      })
    for (const value of [null, { ...lane, removedAt: lane.updatedAt }]) {
      options.store.getLane = () => value
      expect(await resolveLaneQuery(options, 'lane.state', { laneId: lane.laneId })).toMatchObject({
        error: { code: 'unknown-lane' },
      })
    }
    expect(command).not.toHaveBeenCalled()
  })

  it.each([false, true])(
    'maps receipt metadata, timing and workspace paths (live=%s)',
    async (live) => {
      const { options, command } = fixture()

      options.store.listRepositories = () => [
        { id: lane.repositoryId, name: 'Project', path: '/repo' },
      ]
      const receiptTiming = vi.fn(() => ({ start: 10, end: 30 }))
      options.live = { sessionFor: () => (live ? 'runtime-id' : null), receiptTiming }
      options.unattached = () => ({
        ok: true,
        snapshot: {
          summary: lane,
          cursor: { epoch: '0123456789abcdef', seq: 0 },
          state: null,
          messages,
          pending: [],
          dialogs: [],
          ui: [],
        },
      })
      command.mockResolvedValue({
        type: 'response',
        command: 'get_messages',
        success: true,
        data: { messages },
      })
      expect(await resolveLaneQuery(options, 'lane.receipt', { laneId: lane.laneId })).toEqual({
        ok: true,
        data: {
          title: 'Untitled lane',
          branch: 'feature',
          repository: 'Project',
          settledAt: 30,
          durationMs: 20,
          files: 1,
          added: 2,
          removed: 0,
          tests: null,
          artifacts: 0,
          excerpt: 'Done',
          outcome: 'done',
        },
      })
      expect(receiptTiming).toHaveBeenCalledWith(lane.laneId)
      expect(command).toHaveBeenCalledTimes(live ? 1 : 0)
      if (live) expect(command).toHaveBeenCalledWith('runtime-id', { type: 'get_messages' })
    },
  )
})

describe('requestLiveQuery', () => {
  it.each([
    ['lane.state', 'get_state', state],
    ['lane.messages', 'get_messages', { messages: [] }],
    ['lane.receipt', 'get_messages', { messages: [] }],
    ['lane.models', 'get_available_models', { models: [] }],
    ['lane.commands', 'get_commands', { commands: [] }],
    ['lane.stats', 'get_session_stats', stats],
  ] as const)('validates %s and clears its successful deadline', async (method, rpc, data) => {
    vi.useFakeTimers()
    const { options, command } = fixture()
    command.mockResolvedValue({ type: 'response', command: rpc, success: true, data })
    expect(await requestLiveQuery(options, method, 'runtime-id', { type: rpc }, receipt)).toEqual({
      ok: true,
      data: method === 'lane.receipt' ? 'receipt' : data,
    })
    expect(vi.getTimerCount()).toBe(0)
    if (method === 'lane.receipt') expect(receipt).toHaveBeenCalledWith([])
  })

  it.each([
    ['lane.state', { ...state, messageCount: -1 }],
    [
      'lane.messages',
      { messages: Array.from({ length: PI_MESSAGES_MAX + 1 }, () => ({ role: 'user' })) },
    ],
    ['lane.messages', { messages: [{}] }],
    ['lane.receipt', { messages: null }],
    ['lane.models', { models: {} }],
    ['lane.commands', { commands: 'bad' }],
    ['lane.stats', { ...stats, cost: Infinity }],
    ['lane.stats', { ...stats, tokens: { ...stats.tokens, total: NaN } }],
    ['lane.stats', { ...stats, tokens: null }],
    ['lane.stats', null],
    ['lane.stats', []],
  ])('rejects malformed %s and clears its deadline', async (method, data) => {
    vi.useFakeTimers()
    const { options, command } = fixture()
    command.mockResolvedValue({ type: 'response', command: 'get_state', success: true, data })
    expect(
      await requestLiveQuery(options, method, 'runtime-id', { type: 'get_state' }, receipt),
    ).toEqual(internal)
    expect(vi.getTimerCount()).toBe(0)
    expect(receipt).not.toHaveBeenCalled()
  })

  it('cleans up failures, rejections, synchronous throws and receipt errors without leaking details', async () => {
    vi.useFakeTimers()
    const { options, command } = fixture()
    const response: RpcResponse = {
      type: 'response',
      command: 'get_messages',
      success: false,
      error: '/private/stack',
    }
    command
      .mockResolvedValueOnce(response)
      .mockRejectedValueOnce(new Error('/private/stack'))
      .mockImplementationOnce(() => {
        throw new Error('/private/stack')
      })
      .mockResolvedValueOnce({
        type: 'response',
        command: 'get_messages',
        success: true,
        data: { messages: [] },
      })
    const brokenReceipt = () => {
      throw new Error('/private/receipt')
    }
    for (let i = 0; i < 4; i++) {
      expect(
        await requestLiveQuery(
          options,
          'lane.receipt',
          'runtime-id',
          { type: 'get_messages' },
          brokenReceipt,
        ),
      ).toEqual(internal)
      expect(vi.getTimerCount()).toBe(0)
    }
  })

  it('answers exactly at the deadline and ignores late RPC completion', async () => {
    vi.useFakeTimers()
    const { options, command } = fixture()
    let answer: ((value: RpcResponse) => void) | undefined
    command.mockImplementation(
      () =>
        new Promise((resolve) => {
          answer = resolve
        }),
    )
    const settled = vi.fn()
    const pending = requestLiveQuery(
      options,
      'lane.receipt',
      'runtime-id',
      { type: 'get_messages' },
      receipt,
    )
    void pending.then(settled)
    await vi.advanceTimersByTimeAsync(HOST_LIMITS.commandAnswerMs - 1)
    expect(settled).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(await pending).toEqual(internal)
    expect(vi.getTimerCount()).toBe(0)
    answer?.({ type: 'response', command: 'get_messages', success: true, data: { messages: [] } })
    await Promise.resolve()
    expect(receipt).not.toHaveBeenCalled()
    expect(settled).toHaveBeenCalledTimes(1)
  })
})

it('stoppedQuery avoids unnecessary reads and preserves snapshot error distinctions', () => {
  const unattached = vi.fn<LaneQueryOptions['unattached']>(() => null)
  expect(stoppedQuery({ unattached }, 'lane.state', lane.laneId, receipt)).toEqual({
    ok: true,
    data: null,
  })
  expect(stoppedQuery({ unattached }, 'lane.models', lane.laneId, receipt)).toMatchObject({
    error: { code: 'lane-stopped' },
  })
  expect(unattached).not.toHaveBeenCalled()
  expect(stoppedQuery({ unattached }, 'lane.messages', lane.laneId, receipt)).toEqual(internal)
  unattached.mockReturnValue({ ok: false, reason: 'too-large' })
  expect(stoppedQuery({ unattached }, 'lane.receipt', lane.laneId, receipt)).toMatchObject({
    error: { code: 'too-large' },
  })
  unattached.mockImplementation(() => {
    throw new Error('/private/snapshot')
  })
  expect(stoppedQuery({ unattached }, 'lane.messages', lane.laneId, receipt)).toEqual(internal)
})

describe('lane.exportHtml', () => {
  const ID = { laneId: lane.laneId }
  it('gives up at the command deadline instead of holding the call slot', async () => {
    vi.useFakeTimers()
    try {
      const { options } = fixture()
      options.runtime.exportHtml = vi.fn(() => new Promise<string>(() => {}))
      const pending = resolveLaneQuery(options, 'lane.exportHtml', ID)
      await vi.advanceTimersByTimeAsync(HOST_LIMITS.commandAnswerMs)
      await expect(pending).resolves.toMatchObject({ ok: false, error: { code: 'internal' } })
    } finally {
      vi.useRealTimers()
    }
  })

  it('needs sessions.control and returns the Host-exported document of a running lane', async () => {
    const { options, command } = fixture()
    const exportHtml = vi.fn(async () => '<html>lane</html>')
    options.runtime.exportHtml = exportHtml
    expect(laneQueryCapability('lane.exportHtml')).toBe('sessions.control')
    expect(await resolveLaneQuery(options, 'lane.exportHtml', ID)).toEqual({
      ok: true,
      data: { html: '<html>lane</html>' },
    })
    expect(exportHtml).toHaveBeenCalledWith('runtime-id', HOST_LIMITS.outboundFrameBytes / 2)
    expect(command).not.toHaveBeenCalled()
  })

  it('refuses bad params, unknown, stopped and failed exports with their codes', async () => {
    const { options } = fixture()
    const code = async (params: unknown) =>
      ((await resolveLaneQuery(options, 'lane.exportHtml', params)) as { error?: { code: string } })
        .error?.code
    expect(await code(ID)).toBe('unsupported')
    options.runtime.exportHtml = vi.fn(async () => {
      throw new ExportTooLarge('big')
    })
    expect(await code(ID)).toBe('too-large')
    options.runtime.exportHtml = vi.fn(async () => {
      throw new Error('/secret/path')
    })
    expect(await resolveLaneQuery(options, 'lane.exportHtml', ID)).toEqual({
      ok: false,
      error: { code: 'internal', message: 'the lane query could not complete' },
    })
    expect(await code({ laneId: 'bad' })).toBe('bad-request')
    expect(await code(null)).toBe('bad-request')
    options.live.sessionFor = () => null
    expect(await code(ID)).toBe('lane-stopped')
    options.store.getLane = () => null
    expect(await code(ID)).toBe('unknown-lane')
  })
})
