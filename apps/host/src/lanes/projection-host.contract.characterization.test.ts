import { afterEach, expect, it, vi } from 'vitest'
import { HOST_LIMITS, type LaneSummary } from '@phosphor/shared/host-protocol'
import type { RpcCommand, RpcResponse, RpcSessionState } from '@phosphor/shared/rpc'
import { createLaneProjection } from '@phosphor/session-runtime/lanes/projection'
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
const summary: LaneSummary = {
  laneId: '12345678-1234-4234-8234-123456789012',
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
function response(command: RpcCommand['type'], data: unknown): RpcResponse {
  return { type: 'response', command, success: true, data }
}
function deferred() {
  let release: (value: RpcResponse) => void = () => {}
  const promise = new Promise<RpcResponse>((resolve) => {
    release = resolve
  })
  return { promise, release }
}
function setup() {
  const command = vi.fn(async (_id: string, request: RpcCommand) =>
    response(
      request.type,
      request.type === 'get_messages' ? { messages: [{ role: 'user', content: 'fresh' }] } : state,
    ),
  )
  const projection = createLaneProjection({ now: Date.now, overflow: () => {} })
  const binding = createHostLaneProjection({
    runtime: { command },
    sessionId: 'pi',
    laneId: summary.laneId,
    projection,
    summary: () => summary,
    cursor: () => ({ epoch: '0123456789abcdef', seq: 0 }),
    log: vi.fn(),
  })
  return { binding, projection, command }
}
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

it('retries a state-only read superseded by an event revision', async () => {
  const { binding, projection, command } = setup()
  const held = deferred()
  command.mockImplementationOnce(() => held.promise)
  const applied = vi.spyOn(projection, 'setState')
  const reading = binding.stateChanged()
  binding.deliver({ kind: 'event', event: { type: 'turn_start' } })
  held.release(response('get_state', { ...state, messageCount: 99 }))
  await reading
  expect(command.mock.calls.map((c) => c[1].type)).toEqual(['get_state', 'get_state'])
  expect(applied).toHaveBeenCalledExactlyOnceWith(state)
  expect(projection.view().pending.map((e) => e.type)).toEqual(['turn_start'])
})

it('coalesces state and full requests without dropping compaction or later messages', async () => {
  const { binding, projection, command } = setup()
  const held = deferred()
  command.mockImplementationOnce(() => held.promise)
  const reading = binding.stateChanged()
  binding.deliver({
    kind: 'event',
    event: { type: 'compaction_end', reason: 'manual', result: null, aborted: true },
  })
  expect(binding.refresh()).toBe(reading)
  expect(binding.stateChanged()).toBe(reading)
  expect(projection.view().pending.map((e) => e.type)).toEqual(['compaction_end'])
  const messages = deferred()
  command.mockImplementationOnce(() => messages.promise)
  held.release(response('get_state', { ...state, messageCount: 99 }))
  await vi.waitFor(() => expect(command).toHaveBeenCalledTimes(2))
  binding.deliver({
    kind: 'event',
    event: { type: 'message_end', message: { role: 'user', content: 'later' } },
  })
  messages.release(response('get_messages', { messages: [{ role: 'user', content: 'fresh' }] }))
  await reading
  expect(command.mock.calls.map((c) => c[1].type)).toEqual([
    'get_state',
    'get_messages',
    'get_state',
  ])
  expect(projection.view().messages).toEqual([
    { role: 'user', content: 'fresh' },
    { role: 'user', content: 'later' },
  ])
  expect(projection.view().pending).toEqual([])
  expect(projection.view().state).toEqual(state)
})

it('keeps compaction pending on failed refresh and discards a superseded full pair', async () => {
  const { binding, projection, command } = setup()
  command.mockRejectedValueOnce(new Error('failed'))
  binding.deliver({
    kind: 'event',
    event: { type: 'compaction_end', reason: 'manual', result: null, aborted: true },
  })
  await Promise.resolve()
  await Promise.resolve()
  expect(projection.view().pending.map((e) => e.type)).toEqual(['compaction_end'])
  const held = deferred()
  command.mockImplementationOnce(() => held.promise)
  const settled = vi.spyOn(projection, 'settle')
  const reading = binding.refresh()
  void binding.stateChanged()
  held.release(response('get_messages', { messages: [{ role: 'user', content: 'stale' }] }))
  await reading
  expect(settled).toHaveBeenCalledExactlyOnceWith([{ role: 'user', content: 'fresh' }], state)
  expect(projection.view().pending).toEqual([])
})

it.each(['messages', 'state'] as const)(
  'dispose clears timers and prevents late %s reads or pushes from resurrecting the lane',
  async (read) => {
    vi.useFakeTimers()
    const { binding, projection, command } = setup()
    const held = deferred()
    command.mockImplementationOnce(() => held.promise)
    binding.deliver({
      kind: 'extension-ui',
      request: {
        type: 'extension_ui_request',
        id: 'ask',
        method: 'input',
        title: 'Ask',
        timeout: 100,
      },
    })
    const reading = read === 'messages' ? binding.refresh() : binding.stateChanged()
    void binding.refresh()
    const before = binding.snapshot()
    expect(vi.getTimerCount()).toBe(1)
    binding.dispose()
    binding.dispose()
    expect(vi.getTimerCount()).toBe(0)
    binding.deliver({ kind: 'event', event: { type: 'agent_start' } })
    held.release(response(read === 'messages' ? 'get_messages' : 'get_state', state))
    await reading
    await binding.refresh()
    await binding.stateChanged()
    expect(command).toHaveBeenCalledOnce()
    expect(binding.snapshot()).toEqual(before)
    expect(projection.activity()).toBe('needs-input')
  },
)

it('rearms long unref dialog timers at the signed-int cap and resolves only at expiry', () => {
  vi.useFakeTimers()
  const scheduled = vi.spyOn(globalThis, 'setTimeout')
  const { binding, projection } = setup()
  const resolve = vi.spyOn(projection, 'resolveDialog')
  binding.deliver({
    kind: 'extension-ui',
    request: {
      type: 'extension_ui_request',
      id: 'long',
      method: 'input',
      title: 'Long',
      timeout: 2 ** 31 + 2,
    },
  })
  expect(scheduled.mock.calls.map((c) => c[1])).toEqual([2 ** 31 - 1])
  expect(scheduled.mock.results[0]?.value.hasRef()).toBe(false)
  vi.advanceTimersByTime(2 ** 31 - 1)
  expect(resolve).not.toHaveBeenCalled()
  expect(scheduled.mock.calls.map((c) => c[1])).toEqual([2 ** 31 - 1, 3])
  expect(scheduled.mock.results[1]?.value.hasRef()).toBe(false)
  vi.advanceTimersByTime(2)
  expect(projection.view().dialogs).toHaveLength(1)
  vi.advanceTimersByTime(1)
  expect(resolve).toHaveBeenCalledExactlyOnceWith('long')
  expect(vi.getTimerCount()).toBe(0)
})

it('omits only the oldest necessary snapshot images without mutating source or UI status', () => {
  const { binding, projection } = setup()
  const messages = [
    {
      role: 'user' as const,
      content: [
        { type: 'image' as const, mimeType: 'image/png', data: 'a'.repeat(9 * 1024 * 1024) },
        { type: 'image' as const, mimeType: 'image/png', data: 'b'.repeat(9 * 1024 * 1024) },
      ],
    },
  ]
  const status = {
    type: 'extension_ui_request' as const,
    id: 'status',
    method: 'setStatus' as const,
    statusKey: 'phosphor-headroom',
    statusText: '{"remaining":42}',
  }
  projection.settle(messages, state)
  binding.deliver({ kind: 'extension-ui', request: status })
  const result = binding.snapshot()
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error('snapshot did not fit')
  expect(result.snapshot.messages[0]).toMatchObject({
    content: [{ type: 'text', text: '[image omitted: 9216 KB]' }, { type: 'image' }],
  })
  expect(result.snapshot.ui).toEqual([status])
  expect(messages[0]?.content.map((b) => b.type)).toEqual(['image', 'image'])
  expect(projection.view().messages).toEqual(messages)
  projection.settle([{ role: 'user', content: 'x'.repeat(HOST_LIMITS.outboundFrameBytes) }], state)
  expect(binding.snapshot()).toEqual({ ok: false, reason: 'too-large' })
})
