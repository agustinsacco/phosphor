import { afterEach, expect, it, vi } from 'vitest'
import type { ClientFrame } from '@phosphor/shared/host-protocol'
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

it('waits for a slow create across reconnect using the original request ID', () => {
  vi.useFakeTimers()
  const write = vi.fn(() => true)
  const requests = createRequests({
    now: Date.now,
    write,
    later: setTimeout,
    canReplay: () => true,
    changed: () => {},
    transportFailed: () => {},
  })
  const frame = {
    type: 'command',
    requestId: 'create',
    op: { type: 'lane.create', repositoryId: 'repo', worktree: { branch: 'slow', fresh: true } },
  } satisfies ClientFrame
  const created = vi.fn()
  const aborted = vi.fn()
  requests.track(frame, created)
  requests.track({ type: 'command', requestId: 'abort', op: { type: 'abort' } }, aborted)
  try {
    vi.advanceTimersByTime(45_000)
    requests.disconnect(1000)
    requests.prepareReplay()
    requests.flushReplay()
    expect(write).toHaveBeenNthCalledWith(1, frame)
    vi.advanceTimersByTime(30_000)
    expect(aborted).toHaveBeenCalledExactlyOnceWith({ requestId: 'abort', status: 'unknown' })
    expect(created).not.toHaveBeenCalled()
    requests.disconnect(1000)
    requests.prepareReplay()
    requests.flushReplay()
    expect(write).toHaveBeenCalledWith({ type: 'receipt-status', requestId: frame.requestId })
    vi.advanceTimersByTime(50_000)
    const receipt = {
      requestId: frame.requestId,
      status: 'done',
      laneId: 'lane',
      fence: 1,
    } as const
    requests.receipt(receipt)
    requests.receipt(receipt)
    expect(created).toHaveBeenCalledExactlyOnceWith(receipt)
  } finally {
    requests.close()
  }
})

it('bounds the client wait for a create at three minutes', () => {
  vi.useFakeTimers()
  const write = vi.fn(() => true)
  const requests = createRequests({
    now: Date.now,
    write,
    later: setTimeout,
    canReplay: () => true,
    changed: () => {},
    transportFailed: () => {},
  })
  const resolve = vi.fn()
  requests.track(
    {
      type: 'command',
      requestId: 'create',
      op: { type: 'lane.create', repositoryId: 'repo', worktree: null },
    },
    resolve,
  )
  vi.advanceTimersByTime(179_999)
  expect(resolve).not.toHaveBeenCalled()
  vi.advanceTimersByTime(1)
  expect(write).toHaveBeenCalledExactlyOnceWith({ type: 'receipt-status', requestId: 'create' })
  expect(resolve).toHaveBeenCalledExactlyOnceWith({ requestId: 'create', status: 'unknown' })
  requests.close()
})
