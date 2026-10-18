import { afterEach, describe, expect, it, vi } from 'vitest'
import { HOST_LIMITS } from '@phosphor/shared/host-protocol'
import type { AgentMessage, RpcResponse } from '@phosphor/shared/rpc'
import { createLaneCalls } from './calls'
import type { SnapshotResult } from './projection-host'
import type { StoredLane } from './store'

const lane: StoredLane = {
  laneId: '00000000-0000-4000-8000-000000000001',
  repositoryId: '0000000000000000',
  cwd: '/private/repo',
  sessionFile: '/private/session.jsonl',
  removedAt: null,
  title: 'Task',
  branch: 'feature',
  worktree: false,
  model: null,
  activity: 'idle',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  attention: 0,
  read: 0,
  control: { fence: 1, controller: null },
}
const messages: AgentMessage[] = [
  { role: 'user', content: 'Task', timestamp: 10 },
  {
    role: 'assistant',
    content: [{ type: 'text', text: 'Done' }],
    stopReason: 'stop',
    timestamp: 20,
  },
]
const error = (code: string) => ({
  ok: false,
  error: { code, message: 'the lane query could not complete' },
})
function fixture() {
  let snapshot: SnapshotResult | null = {
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
  }
  const command = vi.fn<Parameters<typeof createLaneCalls>[0]['runtime']['command']>()
  const unattached = vi.fn(() => snapshot)
  const options: Parameters<typeof createLaneCalls>[0] = {
    store: { getLane: () => lane, listRepositories: () => [] },
    live: { sessionFor: () => null },
    runtime: { command },
    unattached,
    now: Date.now,
    log: vi.fn(),
  }
  return {
    options,
    command,
    unattached,
    setSnapshot: (value: SnapshotResult | null) => {
      snapshot = value
    },
  }
}
afterEach(() => vi.useRealTimers())

describe('lane call contract', () => {
  it('serves stopped state without reading and messages/receipts from unattached snapshots', async () => {
    const f = fixture()
    const calls = createLaneCalls(f.options)
    const params = { laneId: lane.laneId }
    expect(await calls.call('lane.state', params)).toEqual({ ok: true, data: null })
    expect(f.unattached).not.toHaveBeenCalled()
    expect(await calls.call('lane.messages', params)).toEqual({ ok: true, data: { messages } })
    expect(await calls.call('lane.receipt', params)).toEqual({
      ok: true,
      data: {
        title: 'Task',
        repository: null,
        branch: 'feature',
        settledAt: 20,
        durationMs: 10,
        files: 0,
        added: 0,
        removed: 0,
        tests: null,
        artifacts: 0,
        excerpt: 'Done',
        outcome: 'done',
      },
    })
    for (const method of ['lane.stats', 'lane.models', 'lane.commands'])
      expect(await calls.call(method, params)).toEqual(error('lane-stopped'))
    expect(f.unattached).toHaveBeenCalledTimes(2)
    expect(f.command).not.toHaveBeenCalled()
  })

  it('distinguishes missing and oversized stopped snapshots and hides reader errors', async () => {
    const f = fixture()
    const calls = createLaneCalls(f.options)
    for (const method of ['lane.messages', 'lane.receipt']) {
      f.setSnapshot(null)
      expect(await calls.call(method, { laneId: lane.laneId })).toEqual(error('internal'))
      f.setSnapshot({ ok: false, reason: 'too-large' })
      expect(await calls.call(method, { laneId: lane.laneId })).toEqual(error('too-large'))
    }
    f.unattached.mockImplementation(() => {
      throw new Error('/private/session.jsonl: stack')
    })
    expect(await calls.call('lane.receipt', { laneId: lane.laneId })).toEqual(error('internal'))
  })

  it('maps malformed, failed, thrown and deadline live replies to the fixed internal envelope', async () => {
    vi.useFakeTimers()
    const f = fixture()
    f.options.live = { sessionFor: () => 'live-session' }
    const calls = createLaneCalls(f.options)
    const replies: RpcResponse[] = [
      { type: 'response', command: 'get_messages', success: true, data: { messages: [{}] } },
      { type: 'response', command: 'get_messages', success: false, error: '/private/stack' },
    ]
    for (const response of replies) {
      f.command.mockResolvedValue(response)
      expect(await calls.call('lane.messages', { laneId: lane.laneId })).toEqual(error('internal'))
      expect(vi.getTimerCount()).toBe(0)
    }
    f.command.mockRejectedValue(new Error('/private/stack'))
    expect(await calls.call('lane.messages', { laneId: lane.laneId })).toEqual(error('internal'))
    expect(vi.getTimerCount()).toBe(0)
    f.command.mockImplementation(() => new Promise(() => {}))
    const pending = calls.call('lane.messages', { laneId: lane.laneId })
    await vi.advanceTimersByTimeAsync(HOST_LIMITS.commandAnswerMs)
    expect(await pending).toEqual(error('internal'))
    expect(vi.getTimerCount()).toBe(0)
    expect(f.unattached).not.toHaveBeenCalled()
  })

  it('keeps last registered dispatch precedence but reserves built-in read capabilities', async () => {
    const f = fixture()
    const first = vi.fn(async () => ({ ok: true as const, data: 'first' }))
    const last = vi.fn(async () => ({ ok: true as const, data: 'last' }))
    f.options.features = [
      { methods: ['custom.read', 'lane.state'], capability: 'skills.read', call: first },
      {
        methods: ['custom.read', 'lane.state', 'host.repositories'],
        capability: 'workspaces.read',
        call: last,
      },
    ]
    const calls = createLaneCalls(f.options)
    for (const method of ['custom.read', 'lane.state', 'host.repositories']) {
      expect(calls.capabilityFor(method)).toBe(
        method === 'custom.read' ? 'workspaces.read' : 'sessions.read',
      )
      expect(await calls.call(method, null)).toEqual({ ok: true, data: 'last' })
      expect(last).toHaveBeenLastCalledWith(method, null)
    }
    expect(first).not.toHaveBeenCalled()
    expect(calls.capabilityFor('custom.read.extra')).toBeNull()
    expect(await calls.call('custom.read.extra', {})).toEqual(error('unsupported'))
  })
})
