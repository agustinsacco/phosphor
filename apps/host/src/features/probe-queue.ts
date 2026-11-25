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
  let tail: Promise<unknown> = Promise.resolve()
  let count = 0
  return <T>(probe: (slot: ProbeSlot) => Promise<T>, deadline = probeDeadline()): Promise<T> => {
    if (count >= 8) return Promise.reject(new FeatureFailure('internal'))
    count++
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
    const answer = tail.then(() => {
      slot.budget(Infinity)
      return probe(slot)
    })
    tail = answer
      .then(
        () => exited,
        () => exited,
      )
      .finally(() => {
        count--
      })
    return answer
  }
}
