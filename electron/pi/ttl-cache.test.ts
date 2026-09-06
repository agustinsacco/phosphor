import { describe, expect, it, vi } from 'vitest'
import { createTtlCache } from './ttl-cache'

describe('createTtlCache', () => {
  it('loads once and serves the cached value', async () => {
    const load = vi.fn(async () => 'a')
    const cache = createTtlCache(load, 1000, () => 0)
    expect(await cache.get()).toBe('a')
    expect(await cache.get()).toBe('a')
    expect(load).toHaveBeenCalledOnce()
  })

  it('reloads once the TTL has passed', async () => {
    let now = 0
    const load = vi.fn(async () => now)
    const cache = createTtlCache(load, 1000, () => now)
    expect(await cache.get()).toBe(0)
    now = 999
    expect(await cache.get()).toBe(0)
    now = 1001
    expect(await cache.get()).toBe(1001)
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('dedupes concurrent callers into one load', async () => {
    let resolve: ((value: string) => void) | undefined
    const load = vi.fn(() => new Promise<string>((r) => (resolve = r)))
    const cache = createTtlCache(load, 1000, () => 0)
    const both = Promise.all([cache.get(), cache.get()])
    resolve!('a')
    expect(await both).toEqual(['a', 'a'])
    expect(load).toHaveBeenCalledOnce()
  })

  it('does not cache a failure', async () => {
    const load = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('pi missing'))
      .mockResolvedValueOnce('a')
    const cache = createTtlCache(load, 1000, () => 0)
    await expect(cache.get()).rejects.toThrow('pi missing')
    expect(await cache.get()).toBe('a')
  })

  it('reloads after invalidate', async () => {
    let n = 0
    const cache = createTtlCache(
      async () => ++n,
      10_000,
      () => 0,
    )
    expect(await cache.get()).toBe(1)
    cache.invalidate()
    expect(await cache.get()).toBe(2)
  })

  it('reports freshness', async () => {
    let now = 0
    const cache = createTtlCache(
      async () => 'a',
      100,
      () => now,
    )
    expect(cache.isFresh()).toBe(false)
    await cache.get()
    expect(cache.isFresh()).toBe(true)
    now = 200
    expect(cache.isFresh()).toBe(false)
  })

  // The model catalogue holds pi's own answer for minutes but a models.json
  // fallback for seconds, so one slow boot does not fix a wrong list in place.
  it('takes the TTL from the value when given a function', async () => {
    let now = 0
    let n = 0
    const cache = createTtlCache(
      async () => (++n === 1 ? 'degraded' : 'good'),
      (value) => (value === 'degraded' ? 100 : 10_000),
      () => now,
    )
    expect(await cache.get()).toBe('degraded')

    now = 50
    expect(await cache.get()).toBe('degraded')

    now = 150
    expect(await cache.get()).toBe('good')

    now = 5_000
    expect(await cache.get()).toBe('good')
    expect(n).toBe(2)
  })
})
