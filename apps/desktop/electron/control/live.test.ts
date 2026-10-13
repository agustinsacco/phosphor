import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AccountView } from '@shared/account'
import { createMachinesLive } from './live'
import { liveTimers } from './realtime'
const signedOut: AccountView = { account: { status: 'signed-out' } }
const signedIn: AccountView = {
  account: {
    status: 'signed-in',
    user: { login: 'test', name: null, email: null },
    remembered: false,
  },
}
function harness(initial = signedOut) {
  let apply: (view: AccountView) => void = () => undefined
  let changed: () => void = () => undefined
  let joined: (value: boolean) => void = () => undefined
  const close = vi.fn()
  const off = vi.fn()
  const broadcast = vi.fn()
  const realtime = vi.fn((change, join) => {
    changed = change
    joined = join
    return { stop: close }
  })
  const log = vi.fn()
  const stop = createMachinesLive({
    log,
    snapshot: () => initial,
    subscribe: (listener) => {
      apply = listener
      return off
    },
    realtime,
    timers: liveTimers,
    broadcast,
  })
  return {
    log,
    stop,
    apply: (view: AccountView) => apply(view),
    change: () => changed(),
    join: (value: boolean) => joined(value),
    close,
    off,
    broadcast,
    realtime,
  }
}
beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())
it.each([signedOut])('is inert at disabled startup and starts on sign-in', (initial) => {
  const h = harness(initial)
  expect(h.realtime).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
  h.apply(signedIn)
  expect(h.realtime).toHaveBeenCalledOnce()
  h.apply(signedIn)
  expect(h.realtime).toHaveBeenCalledOnce()
  h.apply(signedOut)
  expect(h.close).toHaveBeenCalledOnce()
  expect(vi.getTimerCount()).toBe(0)
  h.stop()
})
it('coalesces a burst and cancels pending signals on sign-out', async () => {
  const h = harness(signedIn)
  h.change()
  h.change()
  h.change()
  await vi.advanceTimersByTimeAsync(999)
  expect(h.broadcast).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(h.broadcast).toHaveBeenCalledOnce()
  h.change()
  h.apply(signedOut)
  await vi.advanceTimersByTimeAsync(60_000)
  expect(h.broadcast).toHaveBeenCalledOnce()
  h.stop()
  expect(h.off).toHaveBeenCalledOnce()
})
it('polls at 60 seconds only while not joined, and resumes after disconnect', async () => {
  const h = harness(signedIn)
  await vi.advanceTimersByTimeAsync(30_000)
  h.join(false)
  await vi.advanceTimersByTimeAsync(29_999)
  expect(h.broadcast).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1)
  expect(h.broadcast).toHaveBeenCalledOnce()
  h.join(true)
  expect(vi.getTimerCount()).toBe(0)
  await vi.advanceTimersByTimeAsync(120_000)
  expect(h.broadcast).toHaveBeenCalledOnce()
  h.join(false)
  await vi.advanceTimersByTimeAsync(60_000)
  expect(h.broadcast).toHaveBeenCalledTimes(2)
  h.stop()
  expect(vi.getTimerCount()).toBe(0)
})

it('logs fallback start and stop once per lifecycle', () => {
  const h = harness(signedIn)
  expect(h.log.mock.calls).toEqual([['machines', 'fallback.started']])
  vi.advanceTimersByTime(120_000)
  expect(h.log).toHaveBeenCalledTimes(1)
  h.join(true)
  expect(h.log).toHaveBeenLastCalledWith('machines', 'fallback.stopped')
  h.join(false)
  expect(h.log).toHaveBeenLastCalledWith('machines', 'fallback.started')
  h.stop()
  expect(h.log).toHaveBeenLastCalledWith('machines', 'fallback.stopped')
})
