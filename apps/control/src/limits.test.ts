import { expect, it } from 'vitest'
import { BoundedCache, NonceCache, RateLimiter } from './limits'
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
it('sweeps expired nonces at 120 seconds and reuses slots without removing live nonces', () => {
  let now = 0
  const cache = new NonceCache(() => now, 2)
  expect(cache.accept('a', 'nonce')).toBe(true)
  now = 1
  expect(cache.accept('b', 'nonce')).toBe(true)
  now = 119999
  expect(cache.accept('a', 'nonce')).toBe(false)
  now = 120000
  expect(cache.accept('a', 'nonce')).toBe(true)
  expect(cache.accept('b', 'nonce')).toBe(false)
  now = 120001
  expect(cache.accept('c', 'nonce')).toBe(true)
})
