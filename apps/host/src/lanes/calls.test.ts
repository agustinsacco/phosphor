import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HOST_LIMITS } from '@phosphor/shared/host-protocol'
import type { RpcResponse, RpcSessionState } from '@phosphor/shared/rpc'
import { createLaneCalls } from './calls'
import { openStore, type HostStore, type StoredLane } from './store'
import type { SnapshotResult } from './projection-host'
import { createUnattachedSnapshots } from './transcript'

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
let root: string
let store: HostStore
let lane: StoredLane
let sessionId: string | null
let snapshot: SnapshotResult | null
let reply: RpcResponse
const command = vi.fn(async () => reply)
function calls(features: Parameters<typeof createLaneCalls>[0]['features'] = []) {
  return createLaneCalls({
    features,
    store,
    live: { sessionFor: () => sessionId },
    runtime: { command },
    unattached: () => snapshot,
    now: Date.now,
    log: vi.fn(),
  })
}
beforeEach(async () => {
  vi.useFakeTimers()
  root = mkdtempSync(join(tmpdir(), 'host-calls-'))
  const repo = join(root, 'repo')
  mkdirSync(repo)
  store = await openStore(join(root, 'state'), process.getuid?.())
  const repository = store.syncRepositories([repo])[0]
  if (!repository) throw new Error('fixture')
  lane = store.ensureLane({
    repositoryId: repository.id,
    cwd: repo,
    sessionFile: join(root, 'missing.jsonl'),
  })
  sessionId = 'runtime-id'
  snapshot = {
    ok: true,
    snapshot: {
      summary: lane,
      cursor: { epoch: '0123456789abcdef', seq: 0 },
      state: null,
      messages: [],
      pending: [],
      dialogs: [],
      ui: [],
    },
  }
  reply = { type: 'response', command: 'get_state', success: true, data: state }
  command.mockReset().mockImplementation(async () => reply)
})
afterEach(() => {
  store.close()
  rmSync(root, { recursive: true, force: true })
  vi.useRealTimers()
})
describe('lane calls', () => {
  it('dispatches exact registered names with their capabilities, preserving lane methods', async () => {
    const call = vi.fn(async () => ({ ok: true as const, data: 'feature' }))
    const c = calls([
      { capability: 'workspaces.read', methods: ['files.list', 'git.status'], call },
      { capability: 'skills.read', methods: ['machine.models', 'skills.list'], call },
    ])
    for (const method of ['files.list', 'git.status', 'machine.models', 'skills.list']) {
      expect(c.capabilityFor(method)).toBe(
        method.startsWith('files.') || method.startsWith('git.')
          ? 'workspaces.read'
          : 'skills.read',
      )
      expect(await c.call(method, { laneId: lane.laneId })).toEqual({ ok: true, data: 'feature' })
      expect(call).toHaveBeenLastCalledWith(method, { laneId: lane.laneId })
    }
    for (const method of [
      'host.repositories',
      'lane.state',
      'lane.messages',
      'lane.stats',
      'lane.models',
      'lane.commands',
    ])
      expect(c.capabilityFor(method)).toBe('sessions.read')
    for (const method of ['files.list.extra', 'FILES.list', 'machine.model', 'raw-pi-rpc']) {
      expect(c.capabilityFor(method)).toBeNull()
      expect(await c.call(method, {})).toMatchObject({ error: { code: 'unsupported' } })
    }
    expect(call).toHaveBeenCalledTimes(4)
    expect(await c.call('lane.state', { laneId: lane.laneId })).toEqual({ ok: true, data: state })
  })
  it('allows only six methods, validates object params and UUID, excludes removed lanes', async () => {
    const c = calls()
    for (const params of [null, undefined, [], 'text'])
      expect(await c.call('host.repositories', params)).toMatchObject({
        error: { code: 'bad-request' },
      })
    expect(await c.call('host.repositories', { laneId: 'ignored' })).toEqual({
      ok: true,
      data: store.listRepositories(),
    })
    expect(await c.call('raw-pi-rpc', {})).toMatchObject({ error: { code: 'unsupported' } })
    for (const params of [{}, { laneId: 'bad' }, { laneId: 1 }])
      expect(await c.call('lane.state', params)).toMatchObject({ error: { code: 'bad-request' } })
    expect(await c.call('lane.state', { laneId: randomUUID() })).toMatchObject({
      error: { code: 'unknown-lane' },
    })
    store.markRemoved(lane.laneId)
    expect(await c.call('lane.state', { laneId: lane.laneId })).toMatchObject({
      error: { code: 'unknown-lane' },
    })
    expect(command).not.toHaveBeenCalled()
  })
  it.each([
    ['lane.state', 'get_state', state],
    ['lane.messages', 'get_messages', { messages: [{ role: 'user', content: 'hello' }] }],
    ['lane.models', 'get_available_models', { models: [] }],
    ['lane.commands', 'get_commands', { commands: [] }],
    [
      'lane.stats',
      'get_session_stats',
      {
        userMessages: 0,
        assistantMessages: 0,
        toolCalls: 0,
        toolResults: 0,
        totalMessages: 0,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        cost: 0,
      },
    ],
  ])('queries %s through the allowlisted RPC and checks its shape', async (method, rpc, data) => {
    reply = { type: 'response', command: rpc, success: true, data }
    expect(await calls().call(method, { laneId: lane.laneId, ignored: 'ignored' })).toEqual({
      ok: true,
      data,
    })
    expect(command).toHaveBeenCalledWith('runtime-id', { type: rpc })
    reply = {
      type: 'response',
      command: rpc,
      success: true,
      data: { privateOutput: 'do not leak' },
    }
    expect(await calls().call(method, { laneId: lane.laneId })).toMatchObject({
      error: { code: 'internal' },
    })
    reply = { type: 'response', command: 'get_state', success: false, error: 'private pi error' }
    expect(JSON.stringify(await calls().call(method, { laneId: lane.laneId }))).not.toContain(
      'private',
    )
  })
  it('bounds the answer deadline and hides thrown error text', async () => {
    command.mockImplementation(() => new Promise(() => {}))
    const query = calls().call('lane.state', { laneId: lane.laneId })
    await vi.advanceTimersByTimeAsync(HOST_LIMITS.commandAnswerMs - 1)
    let settled = false
    void query.then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(await query).toMatchObject({ error: { code: 'internal' } })
    command.mockRejectedValue(new Error('private stack'))
    expect(JSON.stringify(await calls().call('lane.state', { laneId: lane.laneId }))).not.toContain(
      'private',
    )
  })
  it('serves stopped state/messages, maps reader failure, and never queries stopped catalogues', async () => {
    sessionId = null
    const c = calls(),
      params = { laneId: lane.laneId }
    expect(await c.call('lane.state', params)).toEqual({ ok: true, data: null })
    expect(await c.call('lane.messages', params)).toEqual({ ok: true, data: { messages: [] } })
    for (const method of ['lane.stats', 'lane.models', 'lane.commands'])
      expect(await c.call(method, params)).toMatchObject({ error: { code: 'lane-stopped' } })
    snapshot = null
    expect(await c.call('lane.messages', params)).toMatchObject({ error: { code: 'internal' } })
    snapshot = { ok: false, reason: 'too-large' }
    expect(await c.call('lane.messages', params)).toMatchObject({ error: { code: 'too-large' } })
    expect(command).not.toHaveBeenCalled()
  })
  it('matches stopped snapshot semantics for a file not written yet (ENOENT)', async () => {
    sessionId = null
    const reader = createUnattachedSnapshots({
      store,
      summary: () => lane,
      cursor: () => ({ epoch: '0123456789abcdef', seq: 0 }),
      sessionsRoot: root,
      log: vi.fn(),
    })
    const c = createLaneCalls({
      store,
      live: { sessionFor: () => null },
      runtime: { command },
      unattached: reader,
      now: Date.now,
      log: vi.fn(),
    })
    expect(await c.call('lane.messages', { laneId: lane.laneId })).toEqual({
      ok: true,
      data: { messages: [] },
    })
  })
})

it('checks numeric statistics and token fields independently', async () => {
  const stats = {
    userMessages: 0,
    assistantMessages: 0,
    toolCalls: 0,
    toolResults: 0,
    totalMessages: 0,
    cost: 0,
    tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  }
  for (const data of [
    { ...stats, cost: 'bad' },
    { ...stats, tokens: { ...stats.tokens, input: NaN } },
    { ...stats, tokens: null },
  ]) {
    reply = { type: 'response', command: 'get_session_stats', success: true, data }
    expect(await calls().call('lane.stats', { laneId: lane.laneId })).toMatchObject({
      error: { code: 'internal' },
    })
  }
})
