/**
 * A one-value cache with a TTL and in-flight dedupe.
 *
 * `pi:catalogueModels` spawns a whole `pi --mode rpc --no-session` process and
 * `pi:health` runs `pi --version`, and both were uncached: every model-picker
 * open cost two process spawns, and each renderer caller kept its own copy, so
 * remounting the home screen paid again. Neither answer changes between
 * spawns, so neither needs to be asked twice.
 *
 * Failures are NOT cached — a picker opened while pi was still installing must
 * be able to succeed on the next try rather than serve an error for the whole
 * TTL.
 */
export interface TtlCache<T> {
  get: () => Promise<T>
  /** Drop the cached value; the next `get` reloads. */
  invalidate: () => void
  /** True when a fresh value is already in hand. */
  isFresh: () => boolean
}

/**
 * `ttlMs` may be a function of the value, so an answer that is known to be a
 * degraded stand-in can be held for less time than a good one.
 */
export function createTtlCache<T>(
  load: () => Promise<T>,
  ttlMs: number | ((value: T) => number),
  now: () => number = Date.now,
): TtlCache<T> {
  let value: { at: number; data: T } | null = null
  let inFlight: Promise<T> | null = null

  const ttlFor = (data: T): number => (typeof ttlMs === 'function' ? ttlMs(data) : ttlMs)
  const isFresh = (): boolean => value !== null && now() - value.at < ttlFor(value.data)

  return {
    isFresh,
    invalidate: () => {
      value = null
    },
    get: async () => {
      if (value && isFresh()) return value.data
      // Two pickers opening at once must not spawn two pi processes.
      inFlight ??= load()
        .then((data) => {
          value = { at: now(), data }
          return data
        })
        .finally(() => {
          inFlight = null
        })
      return inFlight
    },
  }
}
