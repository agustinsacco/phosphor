import { afterEach, expect, it, vi } from 'vitest'
import { createRequests } from './requests'

afterEach(() => vi.useRealTimers())
it('retries backpressure with browser timers even without an unref port', () => {
  vi.useFakeTimers()
  const write = vi.fn(() => false)
  const requests = createRequests({
    now: Date.now,
    write,
    later: setTimeout,
    canReplay: () => true,
    changed: () => {},
    transportFailed: () => {},
  })
  requests.track({ type: 'command', requestId: 'request', op: { type: 'abort' } }, () => {})
  requests.prepareReplay()
  requests.flushReplay()
  expect(write).toHaveBeenCalledTimes(1)
  write.mockReturnValue(true)
  vi.advanceTimersByTime(250)
  expect(write).toHaveBeenCalledTimes(2)
  expect(requests.replaying()).toBe(false)
  requests.close()
  expect(vi.getTimerCount()).toBe(0)
})
