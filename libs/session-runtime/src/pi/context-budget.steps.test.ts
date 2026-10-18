import { EventEmitter } from 'node:events'
import { expect, it, vi } from 'vitest'
import type { RpcCommand, RpcResponse } from '@shared/rpc'
import type { PiRpcClient } from './rpc-client'
import { createContextBudgetRuntime } from './context-budget'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function response(command: string, data?: unknown): RpcResponse {
  return { type: 'response', command, success: true, data }
}

function fixture() {
  const events = new EventEmitter()
  const log = vi.fn()
  const runtime = createContextBudgetRuntime(log)
  const request = vi.fn(async (command: RpcCommand): Promise<RpcResponse> => {
    if (command.type === 'get_state') {
      return response(command.type, {
        autoCompactionEnabled: true,
        model: { contextWindow: 1_000_000 },
      })
    }
    return response(command.type, { contextUsage: { tokens: 250_000 } })
  })
  const client = Object.assign(events, { request }) as unknown as Pick<
    PiRpcClient,
    'request' | 'on'
  >
  const settle = () => events.emit('event', { type: 'agent_settled', aborted: false })
  const drain = () => runtime.withBudgetCompaction('session', 'prompt', async () => {})
  return { events, log, runtime, request, client, settle, drain }
}

it('serializes commands and recovers the queue after an action rejects', async () => {
  const { runtime, client, events } = fixture()
  runtime.watchContextBudget('session', client, () => '200k')
  const pending = deferred<void>()
  const order: string[] = []
  const first = runtime.withBudgetCompaction('session', 'prompt', async () => {
    order.push('first')
    await pending.promise
    throw new Error('command failed')
  })
  const failed = expect(first).rejects.toThrow('command failed')
  const second = runtime.withBudgetCompaction('session', 'set_model', async () => {
    order.push('second')
    return { changed: true }
  })
  await Promise.resolve()
  expect(order).toEqual(['first'])
  pending.resolve()
  await failed
  await expect(second).resolves.toEqual({ changed: true })
  expect(order).toEqual(['first', 'second'])
  events.emit('exit')
})

it('coalesces settlement checks while queued or checking and permits a later recheck', async () => {
  const { runtime, client, events, request, settle, drain } = fixture()
  let budget = '200k'
  const readBudget = vi.fn(() => budget)
  runtime.watchContextBudget('session', client, readBudget)
  const pending = deferred<void>()
  const first = runtime.withBudgetCompaction('session', 'prompt', () => pending.promise)
  settle()
  settle()
  budget = '400k'
  expect(readBudget).not.toHaveBeenCalled()
  pending.resolve()
  await first
  await drain()
  expect(readBudget).toHaveBeenCalledOnce()
  expect(request).not.toHaveBeenCalledWith({ type: 'compact' })
  const stats = deferred<RpcResponse>()
  request.mockResolvedValueOnce(
    response('get_state', {
      autoCompactionEnabled: true,
      model: { contextWindow: 1_000_000 },
    }),
  )
  request.mockReturnValueOnce(stats.promise)
  budget = '200k'
  settle()
  await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(4))
  settle()
  stats.resolve(response('get_session_stats', { contextUsage: { tokens: 250_000 } }))
  await drain()
  expect(readBudget).toHaveBeenCalledTimes(2)
  expect(request.mock.calls.filter(([command]) => command.type === 'compact')).toHaveLength(1)
  settle()
  await drain()
  expect(readBudget).toHaveBeenCalledTimes(3)
  events.emit('exit')
})

it.each(['abort', 'exit'] as const)(
  '%s cancels a settlement still waiting behind a command, without reading its budget',
  async (interrupt) => {
    const { runtime, client, events, request, settle, drain } = fixture()
    const readBudget = vi.fn(() => '200k')
    runtime.watchContextBudget('session', client, readBudget)
    const pending = deferred<void>()
    const first = runtime.withBudgetCompaction('session', 'prompt', () => pending.promise)
    await Promise.resolve()
    settle()
    if (interrupt === 'exit') events.emit('exit')
    else await runtime.withBudgetCompaction('session', 'abort', async () => {})
    pending.resolve()
    await first
    await drain()
    expect(readBudget).not.toHaveBeenCalled()
    expect(request).not.toHaveBeenCalled()
    if (interrupt === 'abort') {
      settle()
      await drain()
      expect(request).toHaveBeenCalledWith({ type: 'compact' })
    }
    events.emit('exit')
  },
)

it.each([
  ['get_state', 'abort'],
  ['get_state', 'exit'],
  ['get_session_stats', 'abort'],
  ['get_session_stats', 'exit'],
] as const)('rechecks cancellation after %s resolves following %s', async (boundary, interrupt) => {
  const { runtime, client, events, request, settle, drain } = fixture()
  runtime.watchContextBudget('session', client, () => '200k')
  const held = deferred<RpcResponse>()
  const defaultRequest = request.getMockImplementation()!
  request.mockImplementation((command) =>
    command.type === boundary ? held.promise : defaultRequest(command),
  )
  settle()
  await vi.waitFor(() => expect(request).toHaveBeenCalledWith({ type: boundary }))
  const action = vi.fn(async () => {})
  const queued = expect(runtime.withBudgetCompaction('session', 'prompt', action)).rejects.toThrow(
    'cancelled',
  )
  if (interrupt === 'exit') events.emit('exit')
  else await runtime.withBudgetCompaction('session', 'abort', async () => {})
  held.resolve(await defaultRequest({ type: boundary }))
  await queued
  expect(action).not.toHaveBeenCalled()
  expect(request.mock.calls.map(([command]) => command.type)).toEqual(
    boundary === 'get_state' ? ['get_state'] : ['get_state', 'get_session_stats'],
  )
  request.mockImplementation(defaultRequest)
  if (interrupt === 'abort') {
    await expect(
      runtime.withBudgetCompaction('session', 'prompt', async () => 'new revision'),
    ).resolves.toBe('new revision')
    settle()
    await drain()
    expect(request).toHaveBeenCalledWith({ type: 'compact' })
  }
  events.emit('exit')
})

it('clears checking after budget-policy failure so the next settlement can run', async () => {
  const { runtime, client, events, log, request, settle, drain } = fixture()
  const readBudget = vi
    .fn(() => '200k')
    .mockImplementationOnce(() => {
      throw new Error('policy failed')
    })
  runtime.watchContextBudget('session', client, readBudget)
  settle()
  await drain()
  expect(request).not.toHaveBeenCalled()
  expect(log).toHaveBeenCalledExactlyOnceWith('pi', 'budget check failed', {
    sessionId: 'session',
    error: 'Error: policy failed',
  })
  settle()
  await drain()
  expect(request).toHaveBeenCalledWith({ type: 'compact' })
  events.emit('exit')
})

it('removes an exited gate and supports a new watch of the same session id', async () => {
  const { runtime, client, events, settle, drain } = fixture()
  runtime.watchContextBudget('session', client, () => '200k')
  const pending = deferred<void>()
  const first = runtime.withBudgetCompaction('session', 'prompt', () => pending.promise)
  await Promise.resolve()
  events.emit('exit')
  await expect(
    runtime.withBudgetCompaction('session', 'prompt', async () => 'ungated'),
  ).resolves.toBe('ungated')
  const replacement = fixture()
  runtime.watchContextBudget('session', replacement.client, () => '200k')
  settle()
  await drain()
  expect(replacement.request).not.toHaveBeenCalled()
  replacement.settle()
  await drain()
  expect(replacement.request).toHaveBeenCalledWith({ type: 'compact' })
  pending.resolve()
  await first
  replacement.events.emit('exit')
})

it('waits beyond five minutes for actual compaction completion', async () => {
  const { runtime, client, events, request, settle } = fixture()
  runtime.watchContextBudget('session', client, () => '200k')
  const compact = deferred<RpcResponse>()
  const started = deferred<void>()
  const defaultRequest = request.getMockImplementation()!
  request.mockImplementation((command) => {
    if (command.type !== 'compact') return defaultRequest(command)
    started.resolve()
    return compact.promise
  })
  vi.useFakeTimers()
  try {
    settle()
    const action = vi.fn(async () => 'after compaction')
    const queued = runtime.withBudgetCompaction('session', 'prompt', action)
    await started.promise
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(action).not.toHaveBeenCalled()
    compact.resolve(response('compact'))
    await expect(queued).resolves.toBe('after compaction')
  } finally {
    compact.resolve(response('compact'))
    events.emit('exit')
    vi.useRealTimers()
  }
})
