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
        isStreaming: false,
        isCompacting: false,
      })
    }
    return response(command.type, { contextUsage: { tokens: 250_000 } })
  })
  const client = Object.assign(events, { request }) as unknown as Pick<
    PiRpcClient,
    'request' | 'on'
  >
  const drain = () => runtime.withBudgetCompaction('session', 'prompt', async () => {})
  return { events, log, runtime, request, client, drain }
}

it('checks only settlement, not turn or tool boundaries, and waits for compaction before commands', async () => {
  const { runtime, client, events, request, drain } = fixture()
  runtime.watchContextBudget('session', client, () => '200k')
  for (const type of ['agent_start', 'turn_end', 'tool_execution_end', 'agent_end']) {
    events.emit('event', { type })
  }
  await drain()
  expect(request).not.toHaveBeenCalled()
  const compact = deferred<RpcResponse>()
  request.mockImplementation(async (command) => {
    if (command.type === 'get_state') {
      return response(command.type, {
        autoCompactionEnabled: true,
        model: { contextWindow: 1_000_000 },
      })
    }
    if (command.type === 'compact') return compact.promise
    return response(command.type, { contextUsage: { tokens: 250_000 } })
  })
  events.emit('event', { type: 'agent_settled', aborted: false })
  const action = vi.fn(async () => 'sent')
  const queued = runtime.withBudgetCompaction('session', 'prompt', action)
  await vi.waitFor(() => expect(request).toHaveBeenCalledWith({ type: 'compact' }))
  expect(action).not.toHaveBeenCalled()
  compact.resolve(response('compact'))
  await expect(queued).resolves.toBe('sent')
  expect(request.mock.calls.map(([command]) => command.type)).toEqual([
    'get_state',
    'get_session_stats',
    'compact',
  ])
  events.emit('exit')
})

it('skips paused routine settlements and reads the live budget at the next settlement', async () => {
  const { runtime, client, events, request, drain } = fixture()
  let paused = true
  let budget = '400k'
  runtime.watchContextBudget(
    'session',
    client,
    () => budget,
    () => paused,
  )
  events.emit('event', { type: 'agent_settled', aborted: false })
  paused = false
  await drain()
  expect(request).not.toHaveBeenCalled()
  events.emit('event', { type: 'agent_settled', aborted: false })
  await drain()
  expect(request).not.toHaveBeenCalledWith({ type: 'compact' })
  budget = '200k'
  events.emit('event', { type: 'agent_settled', aborted: false })
  await drain()
  expect(request).toHaveBeenCalledWith({ type: 'compact' })
  events.emit('exit')
})

it.each(['get_state', 'get_messages', 'get_session_stats', 'export_html'] as const)(
  '%s bypasses a queued state-changing command without invalidating it',
  async (command) => {
    const { runtime, client, events } = fixture()
    runtime.watchContextBudget('session', client, () => '200k')
    const pending = deferred<void>()
    const first = runtime.withBudgetCompaction('session', 'prompt', () => pending.promise)
    const sent = vi.fn(async () => 'queued')
    const queued = runtime.withBudgetCompaction('session', 'set_model', sent)
    await expect(
      runtime.withBudgetCompaction('session', command, async () => 'read'),
    ).resolves.toBe('read')
    expect(sent).not.toHaveBeenCalled()
    pending.resolve()
    await first
    await expect(queued).resolves.toBe('queued')
    events.emit('exit')
  },
)

it.each(['abort', 'abort_retry', 'abort_bash', 'clear_queue'] as const)(
  '%s bypasses the queue and invalidates previously queued commands',
  async (command) => {
    const { runtime, client, events } = fixture()
    runtime.watchContextBudget('session', client, () => '200k')
    const pending = deferred<void>()
    const first = runtime.withBudgetCompaction('session', 'prompt', () => pending.promise)
    await Promise.resolve()
    const sent = vi.fn(async () => {})
    const queued = expect(runtime.withBudgetCompaction('session', 'prompt', sent)).rejects.toThrow(
      'Queued command cancelled before compaction finished.',
    )
    await expect(
      runtime.withBudgetCompaction('session', command, async () => 'interrupted'),
    ).resolves.toBe('interrupted')
    pending.resolve()
    await Promise.all([first, queued])
    expect(sent).not.toHaveBeenCalled()
    events.emit('exit')
  },
)

it('invalidates pending commands on exit and stops watching the exited session', async () => {
  const { runtime, client, events, request, drain } = fixture()
  runtime.watchContextBudget('session', client, () => '200k')
  const pending = deferred<void>()
  const first = runtime.withBudgetCompaction('session', 'prompt', () => pending.promise)
  await Promise.resolve()
  const sent = vi.fn(async () => {})
  const queued = expect(runtime.withBudgetCompaction('session', 'prompt', sent)).rejects.toThrow(
    'cancelled',
  )
  events.emit('exit')
  events.emit('event', { type: 'agent_settled', aborted: false })
  pending.resolve()
  await Promise.all([first, queued])
  await drain()
  expect(sent).not.toHaveBeenCalled()
  expect(request).not.toHaveBeenCalled()
})

it('treats unsuccessful checks and rejected RPCs as harmless, and logs compaction failures', async () => {
  const { runtime, client, request, log } = fixture()
  request.mockResolvedValueOnce({
    type: 'response',
    command: 'get_state',
    success: false,
    error: 'unavailable',
  })
  await expect(runtime.enforceContextBudget('session', client, '200k')).resolves.toBeUndefined()
  expect(log).not.toHaveBeenCalled()
  request.mockRejectedValueOnce(new Error('disconnected'))
  await expect(runtime.enforceContextBudget('session', client, '200k')).resolves.toBeUndefined()
  expect(log).toHaveBeenCalledWith('pi', 'budget check failed', {
    sessionId: 'session',
    error: 'Error: disconnected',
  })
  request.mockResolvedValueOnce(
    response('get_state', { autoCompactionEnabled: true, model: { contextWindow: 1_000_000 } }),
  )
  request.mockResolvedValueOnce(
    response('get_session_stats', { contextUsage: { tokens: 250_000 } }),
  )
  request.mockResolvedValueOnce({
    type: 'response',
    command: 'compact',
    success: false,
    error: 'cannot compact',
  })
  await expect(runtime.enforceContextBudget('session', client, '200k')).resolves.toBeUndefined()
  expect(log).toHaveBeenCalledWith('pi', 'budget compaction failed', {
    sessionId: 'session',
    error: 'cannot compact',
  })
})

it('does not compact an active turn or an already compacting session', async () => {
  const { runtime, client, request } = fixture()
  for (const active of [{ isStreaming: true }, { isCompacting: true }]) {
    request.mockResolvedValueOnce(
      response('get_state', {
        ...active,
        autoCompactionEnabled: true,
        model: { contextWindow: 1_000_000 },
      }),
    )
    await runtime.enforceContextBudget('session', client, '200k')
  }
  expect(request.mock.calls.map(([command]) => command.type)).toEqual(['get_state', 'get_state'])
})

it('keeps owners independent even when they watch the same session id', async () => {
  const first = fixture()
  const second = fixture()
  first.runtime.watchContextBudget('session', first.client, () => '200k')
  second.runtime.watchContextBudget('session', second.client, () => '200k')
  const pending = deferred<void>()
  const blocked = first.runtime.withBudgetCompaction('session', 'prompt', () => pending.promise)
  await Promise.resolve()
  const action = vi.fn(async () => 'second')
  await expect(second.runtime.withBudgetCompaction('session', 'prompt', action)).resolves.toBe(
    'second',
  )
  second.events.emit('exit')
  const sent = vi.fn(async () => {})
  const queued = first.runtime.withBudgetCompaction('session', 'prompt', sent)
  expect(sent).not.toHaveBeenCalled()
  pending.resolve()
  await Promise.all([blocked, queued])
  expect(sent).toHaveBeenCalledOnce()
  first.events.emit('exit')
})
