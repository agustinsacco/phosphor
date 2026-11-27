import { HOST_CALL_TIMEOUT_MS } from '@phosphor/shared/host-protocol'
import { FeatureFailure } from './failure'

/** Leave time to send the response before the client drops its call. Includes queue/inspection. */
export const probeDeadline = () => performance.now() + HOST_CALL_TIMEOUT_MS - 1000
export interface ProbeSlot {
  budget(limit: number): number
  holdUntil(exited: Promise<void>): void
  signal?: AbortSignal
}

/** Return the answer immediately, but admit the next probe only after the worker and its child exit. */
export function probeQueue() {
  const waiting = new Set<() => void>()
  let busy = false
  async function enter(deadline: number, signal?: AbortSignal) {
    const remaining = deadline - performance.now()
    const timeout = () => new FeatureFailure('internal', 'queue-timeout', 'queue', remaining)
    const cancelled = () => new FeatureFailure('internal', 'cancelled', 'queue')
    if (signal?.aborted) throw cancelled()
    if (remaining <= 0) throw timeout()
    if (waiting.size >= 7) throw new FeatureFailure('internal', 'queue-full', 'queue')
    if (!busy) {
      busy = true
      return
    }
    await new Promise<void>((resolve, reject) => {
      const clean = () => {
        waiting.delete(admit)
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
      }
      const admit = () => {
        clean()
        resolve()
      }
      const abort = () => {
        clean()
        reject(cancelled())
      }
      const timer = setTimeout(() => {
        clean()
        reject(timeout())
      }, remaining)
      waiting.add(admit)
      signal?.addEventListener('abort', abort, { once: true })
    })
  }
  function release() {
    const next = waiting.values().next().value
    if (next) next()
    else busy = false
  }
  return async <T>(
    probe: (slot: ProbeSlot) => Promise<T>,
    deadline = probeDeadline(),
    signal?: AbortSignal,
  ): Promise<T> => {
    await enter(deadline, signal)
    let exited: Promise<void> | undefined
    const slot: ProbeSlot = {
      ...(signal ? { signal } : {}),
      budget(limit) {
        if (signal?.aborted) throw new FeatureFailure('internal', 'cancelled', 'queue')
        const remaining = deadline - performance.now()
        if (remaining <= 0) throw new FeatureFailure('internal', 'queue-timeout', 'queue')
        return Math.min(limit, remaining)
      },
      holdUntil(child) {
        exited = child
      },
    }
    try {
      slot.budget(Infinity)
      return await probe(slot)
    } finally {
      if (exited) void exited.then(release, release)
      else release()
    }
  }
}
