import type { BrainExtractionCall } from '@shared/brain'

/**
 * How long the model spent on a read: the sum of its calls' traced time. A record's own
 * startedAt is the read's first start and its finishedAt moves on every save, so their gap
 * counts waits, refreshes and app quits. Stages run one call at a time today, so calls never
 * overlap and the sum is exact. A refreshed record holds the questions it asked again, and they
 * count. Null with no calls, or when any call has no trace: an undercount is not honest.
 */
export function readTime(calls: readonly Pick<BrainExtractionCall, 'trace'>[]): number | null {
  let total = 0
  for (const call of calls) {
    if (!call.trace) return null
    total += call.trace.totalMs
  }
  return calls.length ? total : null
}
