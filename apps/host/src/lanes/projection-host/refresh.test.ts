import { afterEach, expect, it, vi } from 'vitest'
import type { RpcCommand, RpcResponse, RpcSessionState } from '@phosphor/shared/rpc'
import { createLaneProjection } from '@phosphor/session-runtime/lanes/projection'
import { PI_MESSAGES_MAX } from '../pi-results'
import { createProjectionRefresh } from './refresh'

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
const messages = [{ role: 'user' as const, content: 'fresh' }]
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
    response(request.type, request.type === 'get_messages' ? { messages } : state),
  )
  const projection = createLaneProjection({ now: Date.now, overflow: () => {} })
  const log = vi.fn()
  const refresh = createProjectionRefresh({
    runtime: { command },
    sessionId: 'pi',
    laneId: 'lane',
    projection,
    log,
  })
  return { refresh, projection, command, log }
}
afterEach(() => vi.restoreAllMocks())

it('marks settle before messages, marks read before state, and settles after both answers', async () => {
  const { refresh, projection, command } = setup()
  const order: string[] = []
  for (const method of ['markSettle', 'markRead'] as const) {
    const original = projection[method]
    vi.spyOn(projection, method).mockImplementation(() => {
      order.push(method)
      original()
    })
  }
  const settle = projection.settle
  vi.spyOn(projection, 'settle').mockImplementation((...args) => {
    order.push('settle')
    settle(...args)
  })
  command.mockImplementation(async (_id, request) => {
    order.push(request.type)
    return response(request.type, request.type === 'get_messages' ? { messages } : state)
  })
  await refresh.refresh()
  expect(order).toEqual(['markSettle', 'get_messages', 'markRead', 'get_state', 'settle'])
  expect(projection.settle).toHaveBeenCalledExactlyOnceWith(messages, state)
})

it('retries state-only revision supersession without applying stale state', async () => {
  const { refresh, projection, command } = setup()
  const held = deferred()
  command.mockImplementationOnce(() => held.promise)
  const applied = vi.spyOn(projection, 'setState')
  const reading = refresh.refresh(false)
  refresh.advanceRevision()
  held.release(response('get_state', { ...state, messageCount: 99 }))
  await reading
  expect(command.mock.calls.map((c) => c[1].type)).toEqual(['get_state', 'get_state'])
  expect(applied).toHaveBeenCalledExactlyOnceWith(state)
})

it('allows full reads across event revisions and reconciles messages after markRead', async () => {
  const { refresh, projection, command } = setup()
  const held = deferred()
  command.mockImplementationOnce(async () => response('get_messages', { messages }))
  command.mockImplementationOnce(() => held.promise)
  const reading = refresh.refresh()
  await vi.waitFor(() => expect(command).toHaveBeenCalledTimes(2))
  refresh.advanceRevision()
  projection.apply({ kind: 'event', event: { type: 'message_end', message: messages[0]! } })
  held.release(response('get_state', state))
  await reading
  expect(command).toHaveBeenCalledTimes(2)
  expect(projection.view().messages).toEqual([...messages, ...messages])
})

it('coalesces newer requests, discards a stale full pair and retains the full-read requirement', async () => {
  const { refresh, projection, command } = setup()
  const held = deferred()
  command.mockImplementationOnce(() => held.promise)
  const settle = vi.spyOn(projection, 'settle')
  const reading = refresh.refresh()
  expect(refresh.refresh(false)).toBe(reading)
  expect(refresh.refresh()).toBe(reading)
  held.release(response('get_messages', { messages: [{ role: 'user', content: 'stale' }] }))
  await reading
  expect(command.mock.calls.map((c) => c[1].type)).toEqual([
    'get_messages',
    'get_state',
    'get_messages',
    'get_state',
  ])
  expect(settle).toHaveBeenCalledExactlyOnceWith(messages, state)
})

it('drains coalesced requests arriving after the loop completes but before finally runs', async () => {
  const { refresh, projection, command } = setup()
  const original = projection.setState
  const applied = vi.spyOn(projection, 'setState').mockImplementationOnce((next) => {
    original(next)
    queueMicrotask(() => {
      void refresh.refresh(false)
      void refresh.refresh(false)
    })
  })
  await refresh.refresh(false)
  expect(command.mock.calls.map((c) => c[1].type)).toEqual(['get_state', 'get_state'])
  expect(applied).toHaveBeenCalledTimes(2)
})

it.each(['get_messages', 'get_state'] as const)(
  'stops during %s without applying late data, logging errors or running queued reads',
  async (read) => {
    const { refresh, projection, command, log } = setup()
    const held = deferred()
    if (read === 'get_state')
      command.mockImplementationOnce(async () => response('get_messages', { messages }))
    command.mockImplementationOnce(() => held.promise)
    const settle = vi.spyOn(projection, 'settle')
    const reading = refresh.refresh()
    await vi.waitFor(() => expect(command).toHaveBeenCalledTimes(read === 'get_state' ? 2 : 1))
    void refresh.refresh()
    refresh.stop()
    refresh.stop()
    held.release({ type: 'response', command: read, success: false, error: 'private failure' })
    await reading
    await refresh.refresh()
    expect(refresh.isStopped()).toBe(true)
    expect(settle).not.toHaveBeenCalled()
    expect(projection.view().state).toBeNull()
    expect(log).not.toHaveBeenCalled()
    expect(command).toHaveBeenCalledTimes(read === 'get_state' ? 2 : 1)
  },
)

it.each([
  ['rpc', undefined],
  ['shape', {}],
  ['size', { messages: Array.from({ length: PI_MESSAGES_MAX + 1 }, () => ({ role: 'user' })) }],
] as const)('logs only the %s failure reason and preserves the last view', async (reason, data) => {
  const { refresh, projection, command, log } = setup()
  await refresh.refresh()
  const before = projection.view()
  command.mockImplementationOnce(async () => response('get_messages', data))
  await refresh.refresh()
  expect(projection.view()).toEqual(before)
  expect(log).toHaveBeenCalledExactlyOnceWith('lanes.refresh_failed', { laneId: 'lane', reason })
})
