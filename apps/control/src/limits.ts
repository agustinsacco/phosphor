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
  private readonly cache: BoundedCache<true>
  constructor(
    private readonly clock: () => number,
    capacity = 100_000,
  ) {
    this.cache = new BoundedCache(clock, capacity)
  }
  accept(identity: string, nonce: string): boolean {
    const key = `${identity}:${nonce}`
    if (this.cache.get(key)) return false
    this.cache.set(key, true, this.clock() + 120_000)
    return true
  }
}
export class RateLimiter {
  private readonly cache: BoundedCache<number[]>
  constructor(
    private readonly clock: () => number,
    capacity = 10_000,
  ) {
    this.cache = new BoundedCache(clock, capacity)
  }
  get size() {
    return this.cache.size
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
    const state = (this.cache.get(key) ?? []).filter((time) => time > now - windowMs)
    if (state.length >= limit) return false
    state.push(now)
    this.cache.set(key, state, now + windowMs)
    return true
  }
}
