import { HOST_CALL_TIMEOUT_MS } from '@phosphor/shared/host-protocol'
import { FeatureFailure } from './machine'

/** Leave time to send the response before the client drops its call. Includes queue/inspection. */
export const probeDeadline = () => performance.now() + HOST_CALL_TIMEOUT_MS - 1000
export interface ProbeSlot {
  budget(limit: number): number
  holdUntil(exited: Promise<void>): void
}

/** Return the answer immediately, but admit the next probe only after the worker and its child exit. */
export function probeQueue() {
  const waiting = new Set<() => void>()
  let busy = false
  async function enter(deadline: number) {
    const remaining = deadline - performance.now()
    if (remaining <= 0 || waiting.size >= 7) throw new FeatureFailure('internal')
    if (!busy) {
      busy = true
      return
    }
    await new Promise<void>((resolve, reject) => {
      const admit = () => {
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(() => {
        waiting.delete(admit)
        reject(new FeatureFailure('internal'))
      }, remaining)
      waiting.add(admit)
    })
  }
  function release() {
    const next = waiting.values().next().value
    if (next) {
      waiting.delete(next)
      next()
    } else busy = false
  }
  return async <T>(
    probe: (slot: ProbeSlot) => Promise<T>,
    deadline = probeDeadline(),
  ): Promise<T> => {
    await enter(deadline)
    let exited: Promise<void> | undefined
    const slot: ProbeSlot = {
      budget(limit) {
        const remaining = deadline - performance.now()
        if (remaining <= 0) throw new FeatureFailure('internal')
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
