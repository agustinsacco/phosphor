import { ControlFailure } from './http'

/** Oldest entries are evicted. Expiration is lazy, so memory never grows with uptime. */
export class BoundedCache<T> {
  private readonly entries = new Map<string, { value: T; expires: number }>()
  constructor(
    private readonly clock: () => number,
    readonly capacity: number,
  ) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Error('Invalid cache capacity')
  }
  get size() {
    return this.entries.size
  }
  get(key: string): T | undefined {
    const entry = this.entries.get(key)
    if (entry && entry.expires > this.clock()) return entry.value
    this.entries.delete(key)
    return undefined
  }
  set(key: string, value: T, expires: number) {
    this.entries.delete(key)
    if (this.entries.size >= this.capacity) {
      const oldest = this.entries.keys().next().value
      if (oldest !== undefined) this.entries.delete(oldest)
    }
    this.entries.set(key, { value, expires })
  }
}
export class NonceCache {
  private readonly entries = new Map<string, number>()
  constructor(
    private readonly clock: () => number,
    private readonly capacity = 100_000,
  ) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Error('Invalid cache capacity')
  }
  accept(identity: string, nonce: string): boolean {
    const now = this.clock()
    // A constant TTL keeps insertion order equal to expiry order, so the sweep stops
    // at the first live entry. If the wall clock steps back, an expired entry can
    // wait behind a live one: that delays reusing its slot, never admits a replay.
    for (const [key, expires] of this.entries) {
      if (expires > now) break
      this.entries.delete(key)
    }
    const key = `${identity}:${nonce}`
    if (this.entries.has(key)) return false
    if (this.entries.size >= this.capacity) throw new ControlFailure('too-many-requests')
    this.entries.set(key, now + 120_000)
    return true
  }
}
export class RateLimiter {
  private readonly entries = new Map<string, { times: number[]; expires: number }>()
  constructor(
    private readonly clock: () => number,
    private readonly capacity = 10_000,
  ) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Error('Invalid cache capacity')
  }
  get size() {
    return this.entries.size
  }
  available(key: string, limit: number, windowMs: number): boolean {
    const entry = this.entries.get(key)
    return (entry?.times.filter((time) => time > this.clock() - windowMs).length ?? 0) < limit
  }
  consume(key: string, limit: number, windowMs: number): boolean {
    if (
      key.length > 512 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 10_000 ||
      !Number.isFinite(windowMs) ||
      windowMs <= 0
    ) {
      throw new Error('Invalid rate limit')
    }
    const now = this.clock()
    const entry = this.entries.get(key)
    const state = (entry?.times ?? []).filter((time) => time > now - windowMs)
    if (state.length >= limit) return false
    if (!entry && this.entries.size >= this.capacity) {
      // Windows may differ in length, so expiry order need not match insertion order.
      for (const [candidate, value] of this.entries) {
        if (value.expires <= now) this.entries.delete(candidate)
      }
      if (this.entries.size >= this.capacity) return false
    }
    state.push(now)
    this.entries.set(key, { times: state, expires: now + windowMs })
    return true
  }
}
