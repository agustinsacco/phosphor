import { expect, it } from 'vitest'
import { BoundedCache, NonceCache, RATE_PURPOSE_CAPACITIES, RateLimiter } from './limits'
it('bounds cache state, evicts oldest and expires exactly at deadline', () => {
  let now = 0
  const cache = new BoundedCache<string>(() => now, 2)
  cache.set('a', 'a', 10)
  cache.set('b', 'b', 10)
  cache.set('c', 'c', 10)
  expect(cache.size).toBe(2)
  expect(cache.get('a')).toBeUndefined()
  expect(cache.get('b')).toBe('b')
  now = 10
  expect(cache.get('b')).toBeUndefined()
  expect(() => new BoundedCache(() => now, 0)).toThrow()
})
it('limits with a sliding window and refuses new keys without resetting live windows', () => {
  let now = 0
  const limit = new RateLimiter(() => now, 2)
  expect(limit.consume('a', 2, 100)).toBe(true)
  now = 50
  expect(limit.consume('a', 2, 100)).toBe(true)
  expect(limit.consume('a', 2, 100)).toBe(false)
  now = 100
  expect(limit.consume('a', 2, 100)).toBe(true)
  expect(limit.consume('a', 2, 100)).toBe(false)
  limit.consume('b', 2, 100)
  expect(limit.consume('c', 2, 100)).toBe(false)
  expect(limit.size).toBe(2)
  expect(limit.consume('a', 2, 100)).toBe(false)
  now = 200
  expect(limit.consume('c', 2, 100)).toBe(true)
  expect(limit.size).toBe(1)
  for (const [key, count, window] of [
    ['x'.repeat(513), 1, 100],
    ['a', 0, 100],
    ['a', 10001, 100],
    ['a', 1, 0],
  ]) {
    expect(() => limit.consume(String(key), Number(count), Number(window))).toThrow()
  }
})
it('refuses saturated nonce caches with 429 and never evicts unexpired replay records', () => {
  const cache = new NonceCache(() => 0, 2)
  expect(cache.accept('a', 'nonce')).toBe(true)
  expect(cache.accept('b', 'nonce')).toBe(true)
  expect(() => cache.accept('c', 'nonce')).toThrowError(
    expect.objectContaining({ code: 'too-many-requests', status: 429 }),
  )
  expect(cache.accept('a', 'nonce')).toBe(false)
})
it('keeps nonces spent through the 120-second skew span and reuses slots at 121 seconds', () => {
  let now = 0
  const cache = new NonceCache(() => now, 2)
  expect(cache.accept('a', 'nonce')).toBe(true)
  now = 1
  expect(cache.accept('b', 'nonce')).toBe(true)
  now = 120_000
  expect(cache.accept('a', 'nonce')).toBe(false)
  expect(() => cache.accept('c', 'nonce')).toThrowError(
    expect.objectContaining({ code: 'too-many-requests', status: 429 }),
  )
  now = 120_999
  expect(cache.accept('a', 'nonce')).toBe(false)
  now = 121_000
  expect(cache.accept('a', 'nonce')).toBe(true)
  expect(cache.accept('b', 'nonce')).toBe(false)
  now = 121_001
  expect(cache.accept('c', 'nonce')).toBe(true)
  expect(cache.accept('a', 'nonce')).toBe(false)
})

it('stays closed when the wall clock steps back: no replay, slots free later', () => {
  let now = 1000
  const cache = new NonceCache(() => now, 2)
  expect(cache.accept('a', 'one')).toBe(true) // expires 122000
  now = 0
  expect(cache.accept('a', 'two')).toBe(true) // expires 121000, behind one
  now = 121_000
  expect(cache.accept('a', 'one')).toBe(false)
  expect(cache.accept('a', 'two')).toBe(false)
  expect(() => cache.accept('a', 'three')).toThrow()
  now = 122_000
  expect(cache.accept('a', 'three')).toBe(true)
  expect(cache.accept('a', 'four')).toBe(true)
})

it('pins available: counts live times in the window without spending, true for unseen keys', () => {
  let now = 0
  const limit = new RateLimiter(() => now, 2)
  expect(limit.available('a', 1, 100)).toBe(true)
  expect(limit.size).toBe(0)
  expect(limit.consume('a', 2, 100)).toBe(true)
  expect(limit.available('a', 1, 100)).toBe(false)
  expect(limit.available('a', 2, 100)).toBe(true)
  expect(limit.available('a', 2, 100)).toBe(true)
  now = 50
  expect(limit.consume('a', 2, 100)).toBe(true)
  expect(limit.available('a', 2, 100)).toBe(false)
  now = 99
  expect(limit.available('a', 2, 100)).toBe(false)
  now = 100
  // The time exactly one window ago has left; a longer window still counts it.
  expect(limit.available('a', 2, 100)).toBe(true)
  expect(limit.available('a', 1, 100)).toBe(false)
  expect(limit.available('a', 2, 101)).toBe(false)
  expect(limit.size).toBe(1)
})

it('pins consume: a refused attempt is not recorded and does not extend the window', () => {
  let now = 0
  const limit = new RateLimiter(() => now, 1)
  expect(limit.consume('a', 1, 100)).toBe(true)
  now = 50
  expect(limit.consume('a', 1, 100)).toBe(false)
  expect(limit.available('a', 1, 100)).toBe(false)
  now = 100
  expect(limit.available('a', 1, 100)).toBe(true)
  expect(limit.consume('a', 1, 100)).toBe(true)
  // A live key keeps consuming while the map is full.
  now = 200
  expect(limit.consume('a', 2, 1000)).toBe(true)
  expect(limit.consume('a', 2, 1000)).toBe(false)
})

it('pins bounded refusal: a new key at capacity sweeps only expired windows, never live ones', () => {
  let now = 0
  const limit = new RateLimiter(() => now, 3)
  expect(limit.consume('short', 5, 100)).toBe(true)
  expect(limit.consume('long', 5, 1000)).toBe(true)
  now = 50
  // The latest consume sets the expiry: this key now lives until 150.
  expect(limit.consume('renewed', 5, 10)).toBe(true)
  expect(limit.consume('renewed', 5, 100)).toBe(true)
  now = 120
  // Expiry is lazy: expired entries stay counted until a new key meets a full map.
  expect(limit.size).toBe(3)
  expect(limit.consume('new', 5, 100)).toBe(true)
  expect(limit.size).toBe(3)
  expect(limit.available('short', 1, 100)).toBe(true)
  expect(limit.consume('other', 5, 100)).toBe(false)
  expect(limit.size).toBe(3)
  expect(limit.available('renewed', 2, 100)).toBe(false)
  expect(limit.available('long', 1, 1000)).toBe(false)
  now = 150
  expect(limit.consume('other', 5, 100)).toBe(true)
  expect(limit.consume('again', 5, 100)).toBe(false)
  expect(limit.available('long', 1, 1000)).toBe(false)
})

it('pins argument checks: boundaries accepted, invalid values throw even at capacity', () => {
  const limit = new RateLimiter(() => 0, 1)
  expect(limit.consume('k'.repeat(512), 10_000, Number.MAX_SAFE_INTEGER)).toBe(true)
  for (const [key, count, window] of [
    ['k'.repeat(512), 1.5, 100],
    ['k'.repeat(512), 1, Number.NaN],
    ['k'.repeat(512), 1, Number.POSITIVE_INFINITY],
    ['fresh', 1, -1],
  ] as const) {
    expect(() => limit.consume(key, count, window)).toThrow('Invalid rate limit')
  }
  expect(limit.consume('fresh', 1, 100)).toBe(false)
  expect(limit.size).toBe(1)
  for (const capacity of [0, -1, 1.5, Number.NaN])
    expect(() => new RateLimiter(() => 0, capacity)).toThrow('Invalid cache capacity')
})

it('gives each declared purpose its own capacity and expiry', () => {
  let now = 0
  const limit = new RateLimiter(() => now, { a: 2, b: 1 })
  expect(limit.consume('a:1', 5, 100)).toBe(true)
  expect(limit.consume('a:2', 5, 1000)).toBe(true)
  expect(limit.consume('a:3', 5, 100)).toBe(false)
  // A full purpose neither refuses another nor evicts its own live windows.
  expect(limit.consume('b:1', 5, 1000)).toBe(true)
  expect(limit.consume('b:2', 5, 100)).toBe(false)
  expect(limit.consume('a:1', 5, 100)).toBe(true)
  expect(limit.size).toBe(3)
  now = 100
  expect(limit.consume('a:3', 5, 100)).toBe(true)
  expect(limit.consume('a:4', 5, 100)).toBe(false)
  expect(limit.consume('b:2', 5, 100)).toBe(false)
  now = 1000
  expect(limit.consume('b:2', 5, 100)).toBe(true)
  expect(limit.size).toBe(3)
})

it('keys the purpose by the prefix before the first colon and refuses undeclared ones', () => {
  const limit = new RateLimiter(() => 0, { 'user-verify': 1 })
  expect(limit.consume('user-verify:2001:db8:0:0::/64', 5, 100)).toBe(true)
  expect(limit.consume('user-verify:192.0.2.1', 5, 100)).toBe(false)
  for (const key of ['enrollment-create:192.0.2.1', 'user-verify', 'User-verify:x', ':x', '']) {
    expect(limit.consume(key, 5, 100)).toBe(false)
    expect(limit.available(key, 5, 100)).toBe(false)
  }
  expect(limit.size).toBe(1)
  // Argument checks come first, whatever the purpose.
  expect(() => limit.consume('unknown:x', 0, 100)).toThrow('Invalid rate limit')
  expect(() => limit.consume('user-verify:' + 'x'.repeat(501), 1, 100)).toThrow()
})

it('reads and spends the same window through available and consume', () => {
  let now = 0
  const limit = new RateLimiter(() => now, { 'enrollment-failure': 1, 'user-verify': 1 })
  const key = 'enrollment-failure:user'
  expect(limit.available(key, 2, 100)).toBe(true)
  expect(limit.consume(key, 2, 100)).toBe(true)
  expect(limit.available(key, 2, 100)).toBe(true)
  expect(limit.consume(key, 2, 100)).toBe(true)
  expect(limit.available(key, 2, 100)).toBe(false)
  expect(limit.available('user-verify:user', 1, 100)).toBe(true)
  now = 100
  expect(limit.available(key, 2, 100)).toBe(true)
})

it('bounds all eight control purposes together at 80,000 keys', () => {
  expect(RATE_PURPOSE_CAPACITIES).toEqual({
    'enrollment-create': 10_000,
    'enrollment-poll-ip': 10_000,
    'enrollment-poll': 10_000,
    'enrollment-failure': 10_000,
    'user-verify': 10_000,
    'host-auth': 10_000,
    'grant-issue': 10_000,
    'client-register': 10_000,
  })
  const limit = new RateLimiter(() => 0, RATE_PURPOSE_CAPACITIES)
  for (const purpose of Object.keys(RATE_PURPOSE_CAPACITIES)) {
    for (let i = 0; i < 10_000; i++) expect(limit.consume(`${purpose}:${i}`, 1, 100)).toBe(true)
    expect(limit.consume(`${purpose}:new`, 1, 100)).toBe(false)
  }
  expect(limit.size).toBe(80_000)
  for (const purpose of Object.keys(RATE_PURPOSE_CAPACITIES))
    expect(limit.consume(`${purpose}:new`, 1, 100)).toBe(false)
  expect(limit.size).toBe(80_000)
  const tables: Record<string, number>[] = [{}, { a: 0 }, { a: 1, b: 1.5 }, { a: Number.NaN }]
  for (const table of tables)
    expect(() => new RateLimiter(() => 0, table)).toThrow('Invalid cache capacity')
})
