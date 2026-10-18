import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionPush } from '@phosphor/shared/models'
import type { HostRuntime } from '../session/runtime'
import {
  deadline,
  isBreakdownStatus,
  isTextDelta,
  send,
  TimedOut,
  watcher,
  within,
} from './accept-waits'

const exit = (code: number): SessionPush => ({ kind: 'exit', code, signal: null, expected: false })

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('accept waits', () => {
  it('shares a deadline across successive operations and clears both race timers', async () => {
    const by = deadline(100)
    await expect(within(Promise.resolve('first'), by, 'first')).resolves.toBe('first')
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(75)
    const pending = within(new Promise(() => {}), by, 'second')
    const assertion = expect(pending).rejects.toThrow('no second within 100 ms')
    await vi.advanceTimersByTimeAsync(25)
    await assertion
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps ordinary promise failures distinct from timeouts', async () => {
    await expect(
      within(Promise.reject(new Error('RPC failed')), deadline(10), 'RPC'),
    ).rejects.toThrow('RPC failed')
    const pending = within(new Promise(() => {}), deadline(10), 'RPC')
    const assertion = expect(pending).rejects.toBeInstanceOf(TimedOut)
    await vi.advanceTimersByTimeAsync(10)
    await assertion
    expect(vi.getTimerCount()).toBe(0)
  })

  it('resolves existing events immediately and prefers a found value over an exit', async () => {
    const watch = watcher()
    watch.deliver(exit(1))
    const mark = watch.mark()
    watch.deliver(exit(2))
    expect(watch.since(mark)).toEqual([exit(2)])
    expect(watch.count('agent_end')).toBe(0)
    await expect(watch.until(() => 'found', deadline(20), 'value')).resolves.toBe('found')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('ignores earlier exits and unregisters a waiter after the next exit', async () => {
    const watch = watcher()
    watch.deliver(exit(1))
    const find = vi.fn(() => undefined)
    const pending = watch.until(find, deadline(100), 'value')
    watch.deliver({ kind: 'exit', code: null, signal: 'SIGTERM', expected: false })
    await expect(pending).rejects.toThrow('pi exited (SIGTERM) while waiting for value')
    const checks = find.mock.calls.length
    watch.deliver(exit(3))
    expect(find).toHaveBeenCalledTimes(checks)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('unregisters timed out and successful waiters so late pushes do not check them', async () => {
    const watch = watcher()
    const find = vi.fn(() => undefined)
    const pending = watch.until(find, deadline(10), 'value')
    const assertion = expect(pending).rejects.toThrow('no value within 10 ms')
    await vi.advanceTimersByTimeAsync(10)
    await assertion
    watch.deliver(exit(0))
    expect(find).toHaveBeenCalledTimes(1)
    const found = vi.fn(() => 'yes')
    await watch.until(found, deadline(10), 'value')
    watch.deliver(exit(0))
    expect(found).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('uses the literal status key and text delta shape', () => {
    const status: SessionPush = {
      kind: 'extension-ui',
      request: {
        type: 'extension_ui_request',
        id: 'status',
        method: 'setStatus',
        statusKey: 'phosphor-context-breakdown',
        statusText: 'loaded',
      },
    }
    expect(isBreakdownStatus(status)).toBe(true)
    expect(isTextDelta(status)).toBe(false)
    expect(isBreakdownStatus(exit(0))).toBe(false)
  })

  it('unwraps typed RPC data and reports a failed envelope without changing the diagnostic', async () => {
    const command = vi.fn<HostRuntime['command']>()
    const runtime = { command }
    command.mockResolvedValueOnce({
      type: 'response',
      command: 'get_last_assistant_text',
      success: true,
      data: { text: 'hello\u2028world\u2029' },
    })
    await expect(
      send(runtime, 'session', { type: 'get_last_assistant_text' }, deadline(20)),
    ).resolves.toEqual({ text: 'hello\u2028world\u2029' })
    command.mockResolvedValueOnce({
      type: 'response',
      command: 'abort',
      success: false,
      error: 'refused',
    })
    await expect(send(runtime, 'session', { type: 'abort' }, deadline(20))).rejects.toThrow(
      'abort failed: refused',
    )
    expect(vi.getTimerCount()).toBe(0)
  })
})
