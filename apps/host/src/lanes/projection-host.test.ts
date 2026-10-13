import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HOST_LIMITS, type LaneSummary } from '@phosphor/shared/host-protocol'
import type { RpcCommand, RpcResponse, RpcSessionState } from '@phosphor/shared/rpc'
import { createLaneProjection } from '@phosphor/session-runtime/lanes/projection'
import { fakeMachine, EXTENSIONS_ROOT } from '../__fixtures__/machine'
import { buildPiEnvironment } from '../machine/environment'
import { createHostLog } from '../machine/log'
import { createHostRuntime } from '../session/runtime'
import { PI_MESSAGES_MAX, piMessages } from './pi-results'
import { createHostLaneProjection } from './projection-host'

const state: RpcSessionState = {
  sessionId: 'pi',
  thinkingLevel: 'off',
  isStreaming: false,
  isCompacting: false,
  steeringMode: 'all',
  followUpMode: 'all',
  autoCompactionEnabled: true,
  messageCount: 0,
  pendingMessageCount: 0,
}
const laneId = '12345678-1234-4234-8234-123456789012'
const summary: LaneSummary = {
  laneId,
  repositoryId: '0123456789abcdef',
  cwd: '/repo',
  title: null,
  branch: null,
  worktree: false,
  model: null,
  activity: 'idle',
  createdAt: '2026-10-13T00:00:00Z',
  updatedAt: '2026-10-13T00:00:00Z',
  attention: 0,
  read: 0,
  control: { fence: 1, controller: null },
}
function setup(
  command = vi.fn(async (_id: string, command: RpcCommand): Promise<RpcResponse> => ({
    type: 'response',
    command: command.type,
    success: true,
    data:
      command.type === 'get_messages' ? { messages: [{ role: 'user', content: 'fresh' }] } : state,
  })),
) {
  const log = vi.fn()
  const projection = createLaneProjection({
    now: () => Date.now(),
    overflow: () => {
      void binding.refresh()
    },
  })
  const binding = createHostLaneProjection({
    runtime: { command },
    sessionId: 'pi',
    laneId,
    projection,
    summary: () => summary,
    cursor: () => ({ epoch: '0123456789abcdef', seq: 0 }),
    log,
  })
  return { binding, projection, log, command }
}
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

describe('Host lane projection', () => {
  it('refreshes on start, state changes, agent end, compaction and overflow; excludes stderr', async () => {
    const { binding: b, projection: p, command } = setup()
    await b.refresh()
    expect(p.view().messages).toEqual([{ role: 'user', content: 'fresh' }])
    b.deliver({ kind: 'stderr', text: 'private' })
    expect(JSON.stringify(b.snapshot())).not.toContain('private')
    command.mockClear()
    await b.stateChanged()
    expect(command.mock.calls.map((c) => c[1].type)).toEqual(['get_state'])
    b.deliver({ kind: 'event', event: { type: 'agent_end', messages: [] } })
    await b.stateChanged()
    expect(p.view().state).toEqual(state)
    command.mockClear()
    b.deliver({
      kind: 'event',
      event: { type: 'compaction_end', reason: 'manual', result: null, aborted: true },
    })
    await b.refresh()
    expect(command.mock.calls.some((c) => c[1].type === 'get_messages')).toBe(true)
    command.mockClear()
    for (let k = 0; k <= HOST_LIMITS.pendingEvents; k++)
      b.deliver({ kind: 'event', event: { type: 'turn_start' } })
    await b.stateChanged()
    expect(command.mock.calls.some((c) => c[1].type === 'get_messages')).toBe(true)
    expect(p.view().pending).toEqual([])
  })
  it.each([
    ['shape', { messages: {} }, state],
    ['shape', { messages: [{}] }, state],
    [
      'size',
      { messages: Array.from({ length: PI_MESSAGES_MAX + 1 }, () => ({ role: 'user' })) },
      state,
    ],
    ['shape', { messages: [] }, { ...state, isStreaming: undefined }],
  ] as const)('keeps the previous view for %s failures', async (reason, messages, nextState) => {
    const { binding: b, projection: p, command, log } = setup()
    await b.refresh()
    const before = p.view()
    command.mockImplementation(async (_id, command) => ({
      type: 'response',
      command: command.type,
      success: true,
      data: command.type === 'get_messages' ? messages : nextState,
    }))
    await b.refresh()
    expect(p.view()).toEqual(before)
    expect(log).toHaveBeenCalledWith('lanes.refresh_failed', { laneId, reason })
  })
  it('accepts the message cap, rejects malformed state and keeps the previous view on RPC errors', async () => {
    expect(
      piMessages(Array.from({ length: PI_MESSAGES_MAX }, () => ({ role: 'user' })))?.length,
    ).toBe(PI_MESSAGES_MAX)
    const { binding: b, projection: p, command, log } = setup()
    await b.refresh()
    const before = p.view()
    command.mockResolvedValue({
      type: 'response',
      command: 'get_messages',
      success: false,
      error: 'private error',
    })
    await b.refresh()
    expect(p.view()).toEqual(before)
    expect(log).toHaveBeenLastCalledWith('lanes.refresh_failed', { laneId, reason: 'rpc' })
    command.mockRejectedValue(new Error('private error'))
    await b.refresh()
    expect(p.view()).toEqual(before)
    expect(JSON.stringify(log.mock.calls)).not.toContain('private')
  })
  it('serializes reads and discards stale results when a steer or next turn arrives during compaction refresh', async () => {
    let release: (value: RpcResponse) => void = () => {}
    const held = new Promise<RpcResponse>((resolve) => {
      release = resolve
    })
    const { binding: b, projection: p, command } = setup()
    await b.refresh()
    const before = p.view().messages
    const settled = vi.spyOn(p, 'settle')
    command.mockImplementationOnce(() => held)
    b.deliver({
      kind: 'event',
      event: {
        type: 'compaction_end',
        reason: 'manual',
        result: { summary: 'compact', firstKeptEntryId: 'id', tokensBefore: 10 },
        aborted: false,
      },
    })
    const reading = b.refresh()
    expect(command.mock.calls.filter((c) => c[1].type === 'get_messages')).toHaveLength(2)
    b.deliver({ kind: 'event', event: { type: 'queue_update', steering: ['next'], followUp: [] } })
    b.deliver({ kind: 'event', event: { type: 'agent_start' } })
    expect(p.view().messages).toEqual(before)
    expect(p.view().pending.some((e) => e.type === 'compaction_end')).toBe(true)
    expect(command.mock.calls.filter((c) => c[1].type === 'get_state')).toHaveLength(1)
    release({
      type: 'response',
      command: 'get_messages',
      success: true,
      data: { messages: [{ role: 'user', content: 'stale' }] },
    })
    await reading
    expect(settled).toHaveBeenCalledOnce()
    expect(p.view().messages).toEqual([{ role: 'user', content: 'fresh' }])
    expect(p.view().pending.map((e) => e.type)).toEqual(['queue_update', 'agent_start'])
    command.mockRejectedValueOnce(new Error('failed settle'))
    b.deliver({
      kind: 'event',
      event: { type: 'compaction_end', reason: 'manual', result: null, aborted: true },
    })
    await b.stateChanged()
    expect(p.view().pending.some((e) => e.type === 'compaction_end')).toBe(true)
  })
  it('drains a coalesced request arriving between completion and finalization', async () => {
    const { binding: b, projection: p, command } = setup()
    const original = p.setState
    const applied = vi.spyOn(p, 'setState').mockImplementationOnce((next) => {
      original(next)
      // runRefresh returns after applying state. This runs before its finalizer.
      queueMicrotask(() => {
        void b.stateChanged()
        void b.stateChanged()
      })
    })
    await b.stateChanged()
    expect(command.mock.calls.map((c) => c[1].type)).toEqual(['get_state', 'get_state'])
    expect(applied).toHaveBeenCalledTimes(2)
  })
  it.each(['messages', 'state'] as const)(
    'disposes timers and refresh queues while a %s read is outstanding',
    async (read) => {
      vi.useFakeTimers()
      const { binding: b, projection: p, command } = setup()
      let release: (response: RpcResponse) => void = () => {}
      command.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve
          }),
      )
      b.deliver({
        kind: 'extension-ui',
        request: {
          type: 'extension_ui_request',
          id: 'dialog',
          method: 'input',
          title: 'ask',
          timeout: 10,
        },
      })
      b.deliver({
        kind: 'event',
        event: { type: 'queue_update', steering: ['queued'], followUp: [] },
      })
      const settled = vi.spyOn(p, 'settle')
      const setState = vi.spyOn(p, 'setState')
      const apply = vi.spyOn(p, 'apply')
      const reading = read === 'messages' ? b.refresh() : b.stateChanged()
      // Coalesce another full read while the first one is still outstanding.
      void b.refresh()
      const before = b.snapshot()
      expect(vi.getTimerCount()).toBe(1)
      b.dispose()
      b.dispose()
      expect(vi.getTimerCount()).toBe(0)
      b.deliver({ kind: 'event', event: { type: 'agent_start' } })
      await b.refresh()
      await b.stateChanged()
      release({
        type: 'response',
        command: read === 'messages' ? 'get_messages' : 'get_state',
        success: true,
        data: read === 'messages' ? { messages: [] } : state,
      })
      await reading
      expect(settled).not.toHaveBeenCalled()
      expect(setState).not.toHaveBeenCalled()
      expect(apply).not.toHaveBeenCalled()
      expect(command).toHaveBeenCalledOnce()
      expect(b.snapshot()).toEqual(before)
      vi.advanceTimersByTime(10)
      expect(vi.getTimerCount()).toBe(0)
      b.dispose()
    },
  )
  it('drives unref timeouts, resolves answers, replaces timers and clears on exit', () => {
    vi.useFakeTimers()
    const scheduled = vi.spyOn(globalThis, 'setTimeout')
    const { binding: b, projection: p } = setup()
    const ask = (id: string) =>
      b.deliver({
        kind: 'extension-ui',
        request: { type: 'extension_ui_request', id, method: 'input', title: 'ask', timeout: 10 },
      })
    ask('a')
    const first = scheduled.mock.results[0]
    if (first?.type !== 'return') throw new Error('timer was not armed')
    expect(first.value.hasRef()).toBe(false)
    expect(vi.getTimerCount()).toBe(1)
    ask('a')
    expect(vi.getTimerCount()).toBe(1)
    b.resolveDialog('a')
    expect(vi.getTimerCount()).toBe(0)
    ask('b')
    vi.advanceTimersByTime(9)
    expect(p.view().dialogs).toHaveLength(1)
    vi.advanceTimersByTime(1)
    expect(p.view().dialogs).toHaveLength(0)
    ask('c')
    b.deliver({
      kind: 'extension-ui',
      request: { type: 'extension_ui_request', id: 'c', method: 'editor', title: 'replacement' },
    })
    vi.advanceTimersByTime(10)
    expect(p.view().dialogs.map((d) => d.id)).toEqual(['c'])
    expect(vi.getTimerCount()).toBe(0)
    b.resolveDialog('c')
    b.deliver({
      kind: 'extension-ui',
      request: {
        type: 'extension_ui_request',
        id: 'long',
        method: 'input',
        title: 'long',
        timeout: 2 ** 31 + 2,
      },
    })
    vi.advanceTimersByTime(2 ** 31 - 1)
    expect(p.view().dialogs).toHaveLength(1)
    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(3)
    expect(p.view().dialogs).toHaveLength(0)
    ask('c')
    b.deliver({ kind: 'exit', code: 0, signal: null, expected: true })
    expect(vi.getTimerCount()).toBe(0)
    expect(p.view().dialogs).toHaveLength(0)
  })
  it('does not resurrect an exited lane when a refresh completes', async () => {
    let release: (value: RpcResponse) => void = () => {}
    const { binding: b, projection: p, command } = setup()
    command.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve
        }),
    )
    const reading = b.refresh()
    b.deliver({ kind: 'exit', code: 1, signal: null, expected: false })
    release({ type: 'response', command: 'get_messages', success: true, data: { messages: [] } })
    await reading
    expect(p.view().state).toBeNull()
    expect(p.activity()).toBe('failed')
    b.dispose()
    expect(p.activity()).toBe('failed')
    expect(p.view().pending).toEqual([])
  })
  it('elides images oldest first without mutating the projection, then rejects oversized text', () => {
    const { binding: b, projection: p } = setup()
    p.settle(
      [
        {
          role: 'user',
          content: [
            { type: 'image', mimeType: 'image/png', data: 'a'.repeat(9 * 1024 * 1024) },
            { type: 'image', mimeType: 'image/png', data: 'b'.repeat(9 * 1024 * 1024) },
          ],
        },
      ],
      state,
    )
    const result = b.snapshot()
    expect(result.ok).toBe(true)
    if (result.ok)
      expect(result.snapshot.messages[0]).toMatchObject({
        content: [{ type: 'text', text: '[image omitted: 9216 KB]' }, { type: 'image' }],
      })
    expect(p.view().messages[0]).toMatchObject({ content: [{ type: 'image' }, { type: 'image' }] })
    p.settle([{ role: 'user', content: 'x'.repeat(HOST_LIMITS.outboundFrameBytes) }], state)
    expect(b.snapshot()).toEqual({ ok: false, reason: 'too-large' })
  })
  it('accepts the exact snapshot byte limit and rejects one UTF-8 byte past it', () => {
    const { binding: b, projection: p } = setup()
    p.settle([{ role: 'user', content: '' }], state)
    const empty = b.snapshot()
    if (!empty.ok) throw new Error('empty snapshot failed')
    const count =
      HOST_LIMITS.outboundFrameBytes - 64 * 1024 - Buffer.byteLength(JSON.stringify(empty.snapshot))
    p.settle([{ role: 'user', content: 'x'.repeat(count) }], state)
    expect(b.snapshot().ok).toBe(true)
    p.settle([{ role: 'user', content: 'x'.repeat(count + 1) }], state)
    expect(b.snapshot().ok).toBe(false)
    p.settle([{ role: 'user', content: 'x'.repeat(count - 1) + 'é' }], state)
    expect(b.snapshot().ok).toBe(false)
  })
  it('refreshes and watches a HostRuntime session using only the scratch fake pi', async () => {
    const machine = fakeMachine({ rpc: true })
    vi.stubEnv('PATH', process.env.PATH)
    const env = buildPiEnvironment({
      hostEnv: machine.hostEnv,
      pass: [],
      nodePath: process.execPath,
      platform: process.platform,
    }).env
    const runtime = createHostRuntime({
      pi: { binaryPath: process.execPath, prefixArgs: [machine.pi] },
      env,
      roots: [machine.repository],
      resourceRoot: EXTENSIONS_ROOT,
      contextBudget: '',
      log: createHostLog(join(machine.dir, 'logs'), []),
    })
    try {
      runtime.life.to('validating')
      runtime.life.to('ready')
      const route: { binding?: ReturnType<typeof createHostLaneProjection> } = {}
      const p = createLaneProjection({
        now: () => Date.now(),
        overflow: () => {
          void route.binding?.refresh()
        },
      })
      const session = await runtime.start({ repository: machine.repository }, (push) => {
        if (route.binding) route.binding.deliver(push)
        else if (push.kind !== 'stderr') p.apply(push)
      })
      const binding = createHostLaneProjection({
        runtime,
        sessionId: session.sessionId,
        laneId,
        projection: p,
        summary: () => summary,
        cursor: () => ({ epoch: '0123456789abcdef', seq: 0 }),
        log: vi.fn(),
      })
      route.binding = binding
      await binding.refresh()
      expect(p.view().state?.sessionId).toBeTruthy()
      await runtime.command(session.sessionId, { type: 'prompt', message: 'hello' })
      await expect.poll(() => p.view().messages.length).toBe(2)
      await binding.stateChanged()
      expect(p.activity()).toBe('idle')
      expect(binding.snapshot().ok).toBe(true)
      await runtime.stop(session.sessionId)
      expect(p.activity()).toBe('stopped')
    } finally {
      await runtime.drain('test over')
      machine.cleanup()
    }
  })
})
