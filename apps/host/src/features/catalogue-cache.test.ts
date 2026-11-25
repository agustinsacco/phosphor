import { afterEach, expect, it, vi } from 'vitest'
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
