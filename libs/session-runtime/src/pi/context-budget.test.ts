import { EventEmitter } from 'node:events'
import { expect, it, vi } from 'vitest'
import type { PiRpcClient } from './rpc-client'
import type { RpcCommand } from '@shared/rpc'
import { createContextBudgetRuntime } from './context-budget'

vi.mock('electron', () => {
  throw new Error('Context-budget runtime imported Electron')
})

function fixture() {
  const events = new EventEmitter()
  const request = vi.fn(async (command: RpcCommand) => ({
    success: true,
    data:
      command.type === 'get_state'
        ? { autoCompactionEnabled: true, model: { contextWindow: 1_000_000 } }
        : { contextUsage: { tokens: 250_000 } },
  }))
  const client = Object.assign(events, { request }) as unknown as Pick<
    PiRpcClient,
    'request' | 'on'
  >
  return { events, request, client }
}

it('keeps command gates independent even when two owners use the same session id', async () => {
  const first = createContextBudgetRuntime(vi.fn())
  const second = createContextBudgetRuntime(vi.fn())
  const a = fixture(),
    b = fixture()
  first.watchContextBudget('same', a.client, () => '')
  second.watchContextBudget('same', b.client, () => '')
  let release!: () => void
  const waiting = new Promise<void>((resolve) => {
    release = resolve
  })
  const block = first.withBudgetCompaction('same', 'prompt', () => waiting)
  const sent = vi.fn(async () => {})
  const independent = second.withBudgetCompaction('same', 'prompt', sent)
  try {
    await vi.waitFor(() => expect(sent).toHaveBeenCalledOnce())
    // Exiting one owner must not discard the other's gate.
    b.events.emit('exit')
    const read = vi.fn(async () => {})
    await first.withBudgetCompaction('same', 'get_state', read)
    expect(read).toHaveBeenCalledOnce()
    const cancelled = expect(first.withBudgetCompaction('same', 'prompt', sent)).rejects.toThrow(
      'cancelled',
    )
    await first.withBudgetCompaction('same', 'abort', async () => {})
    release()
    await cancelled
    expect(sent).toHaveBeenCalledTimes(1)
  } finally {
    release()
    await Promise.all([block, independent])
    a.events.emit('exit')
    b.events.emit('exit')
  }
})

it('reads live budget and pause policy, and sends diagnostics only to its injected logger', async () => {
  const log = vi.fn()
  const runtime = createContextBudgetRuntime(log)
  const { events, client, request } = fixture()
  let budget = '400k',
    paused = false
  runtime.watchContextBudget(
    'session',
    client,
    () => budget,
    () => paused,
  )
  const settled = async () => {
    events.emit('event', { type: 'agent_settled', aborted: false })
    await runtime.withBudgetCompaction('session', 'prompt', async () => {})
  }
  try {
    await settled()
    expect(request).not.toHaveBeenCalledWith({ type: 'compact' })
    budget = '200k'
    paused = true
    request.mockClear()
    await settled()
    expect(request).not.toHaveBeenCalled()
    paused = false
    await settled()
    expect(request).toHaveBeenCalledWith({ type: 'compact' })
    expect(log).toHaveBeenCalledExactlyOnceWith('pi', 'context over budget; compacting', {
      sessionId: 'session',
      tokens: 250_000,
      budget: 200_000,
    })
    events.emit('exit')
    request.mockClear()
    await settled()
    expect(request).not.toHaveBeenCalled()
  } finally {
    events.emit('exit')
  }
})
