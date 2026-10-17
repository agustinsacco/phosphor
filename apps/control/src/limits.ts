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
/**
 * The control plane's rate-limit purposes: a key's purpose is its prefix before the
 * first colon. Each purpose holds its own keys, so saturating one never refuses
 * another, and together they hold at most 80,000.
 */
export const RATE_PURPOSE_CAPACITIES = Object.freeze({
  'enrollment-create': 10_000,
  'enrollment-poll-ip': 10_000,
  'enrollment-poll': 10_000,
  'enrollment-failure': 10_000,
  'user-verify': 10_000,
  'host-auth': 10_000,
  'grant-issue': 10_000,
  'client-register': 10_000,
})
/**
 * Sliding windows in one map of at most `capacity` keys. Given a table of purpose
 * capacities instead, each declared purpose gets its own such limiter and a key of an
 * undeclared purpose is refused.
 */
export class RateLimiter {
  private readonly entries = new Map<string, { times: number[]; expires: number }>()
  private readonly purposes: ReadonlyMap<string, RateLimiter> | null
  /** Most keys held at once: in purpose mode, the purposes' capacities together. */
  private readonly capacity: number
  constructor(
    private readonly clock: () => number,
    capacity: number | Readonly<Record<string, number>> = 10_000,
  ) {
    if (typeof capacity === 'number') {
      this.purposes = null
      this.capacity = capacity
    } else {
      const purposes = Object.entries(capacity).map(
        ([name, keys]) => [name, new RateLimiter(clock, keys)] as const,
      )
      this.purposes = new Map(purposes)
      this.capacity = purposes.reduce((total, [, purpose]) => total + purpose.capacity, 0)
    }
    if (!Number.isSafeInteger(this.capacity) || this.capacity < 1)
      throw new Error('Invalid cache capacity')
  }
  get size() {
    if (!this.purposes) return this.entries.size
    let size = 0
    for (const purpose of this.purposes.values()) size += purpose.size
    return size
  }
  available(key: string, limit: number, windowMs: number): boolean {
    if (this.purposes) return this.purpose(key)?.available(key, limit, windowMs) ?? false
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
    if (this.purposes) return this.purpose(key)?.consume(key, limit, windowMs) ?? false
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
  private purpose(key: string): RateLimiter | undefined {
    const colon = key.indexOf(':')
    return colon < 0 ? undefined : this.purposes?.get(key.slice(0, colon))
  }
}
