/** How long a woken page waits for a pong before it trusts the socket is dead. */
export const WAKE_PROBE_MS = 8000

/**
 * When a dropped connection tries again. Jittered exponential backoff (1s,
 * doubling, capped at 60s); a rate limit waits at least 30s. A phone that slept
 * comes back with the next try far away, so `wake` takes it now, except
 * through a rate limit, which the Host asked us to respect.
 */
export function createRetry(
  later: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>,
  connect: () => void,
  now: () => number,
  random: () => number = Math.random,
) {
  let attempt = 0
  let pending: { timer: ReturnType<typeof setTimeout>; notBefore: number } | undefined
  return {
    /** A completed handshake: the next drop retries within a second. */
    reset() {
      attempt = 0
      pending = undefined
    },
    schedule(rateLimited: boolean) {
      const delay = Math.min(60_000, 1000 * 2 ** Math.min(attempt++, 6)) * random()
      const notBefore = rateLimited ? now() + 30_000 : 0
      const timer = later(
        () => {
          pending = undefined
          connect()
        },
        Math.max(notBefore - now(), delay),
      )
      pending = { timer, notBefore }
    },
    /** True when a retry was waiting and has started now. */
    wake(): boolean {
      if (!pending || now() < pending.notBefore) return false
      clearTimeout(pending.timer)
      pending = undefined
      attempt = 0
      connect()
      return true
    },
  }
}
