import { afterEach, expect, it, vi } from 'vitest'
import { probeQueue } from './probe-queue'
import { CatalogueCache } from './catalogue-cache'

afterEach(() => vi.useRealTimers())
it('serves the last good answer during a single stale refresh and after its failure', async () => {
  vi.useFakeTimers()
  const cache = new CatalogueCache<string>()
  let fail!: (error: Error) => void
  const read = vi
    .fn<() => Promise<string>>()
    .mockResolvedValueOnce('cached')
    .mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          fail = reject
        }),
    )
  expect(await Promise.all([cache.get('key', read), cache.get('key', read)])).toEqual([
    'cached',
    'cached',
  ])
  expect(read).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(61_000)
  expect(await Promise.all([cache.get('key', read), cache.get('key', read)])).toEqual([
    'cached',
    'cached',
  ])
  expect(read).toHaveBeenCalledTimes(2)
  fail(new Error('pi failed'))
  await vi.advanceTimersByTimeAsync(1)
  expect(await cache.get('key', read)).toBe('cached')
  expect(read).toHaveBeenCalledTimes(2)
})

it('expires a queued probe at the wire deadline rather than running it late', async () => {
  vi.useFakeTimers()
  const queue = probeQueue()
  let finish!: () => void
  const first = queue(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve
      }),
  )
  const late = vi.fn(async () => 'too late')
  const expired = vi.fn()
  const waiting = Array.from({ length: 7 }, () => queue(late).catch(expired))
  await vi.advanceTimersByTimeAsync(29_000)
  expect(expired).toHaveBeenCalledTimes(7)
  expect(late).not.toHaveBeenCalled()
  // All expired waiters have left the queue even though the blocker still owns its slot.
  const next = queue(async () => 'next')
  finish()
  await Promise.all([first, ...waiting])
  expect(await next).toBe('next')
  expect(late).not.toHaveBeenCalled()
})
