import type { RepoPullRequests } from '@/stores/pullRequests'
import type { PrStatusEntry } from '@/stores/prStatus'
import type { LanePr } from '../lanePrs'

/**
 * How fresh one PR's status is, from that PR's own read. A PR read by number
 * answers from its `prStatus` entry; only a PR known from branch discovery
 * alone falls back to the repository listing, and only the checkout's PR may
 * use the checkout branch's coverage (reading it for another PR said "No
 * successful upstream check yet" for a PR that was read seconds ago).
 */
export interface PrFreshness {
  /** Last successful upstream observation; 0 when never. */
  checkedAt: number
  /** Last attempt, failed or not. */
  attemptedAt: number
  /** The last attempt failed: what shows may be old. */
  stale: boolean
  loading: boolean
}

export function prFreshness(
  lane: LanePr,
  entry: PrStatusEntry | undefined,
  slice: RepoPullRequests | undefined,
  branch: string | undefined,
): PrFreshness {
  if (lane.ref && entry?.attemptedAt) {
    const checkedAt = entry.coverage?.checkedAt || entry.fetchedAt
    return { checkedAt, attemptedAt: entry.attemptedAt, stale: lane.stale, loading: false }
  }
  if (!slice) return { checkedAt: 0, attemptedAt: 0, stale: lane.stale, loading: false }
  const coverage = lane.source === 'checkout' && branch ? slice.coverage?.[branch] : undefined
  return {
    checkedAt: coverage ? coverage.checkedAt : slice.fetchedAt,
    attemptedAt: coverage?.attemptedAt ?? slice.attemptedAt,
    stale: lane.stale || !!slice.failed || coverage?.state === 'unavailable',
    loading: slice.loading,
  }
}

/** `12s ago` under a minute, then `4m ago`, `3h ago`, `2d ago`. */
export function agoText(at: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - at) / 1_000))
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

/** The meta line's freshness words, and the tooltip that explains them. */
export function freshnessText(fresh: PrFreshness, now: number): { text: string; detail: string } {
  if (fresh.stale) {
    const failed = fresh.attemptedAt ? ` ${agoText(fresh.attemptedAt, now)}` : ''
    return {
      text: 'stale',
      detail: fresh.checkedAt
        ? `The last read failed${failed}. Showing status from ${agoText(fresh.checkedAt, now)}.`
        : `The last read failed${failed}. Status unavailable.`,
    }
  }
  if (fresh.checkedAt) {
    const ago = agoText(fresh.checkedAt, now)
    return { text: `checked ${ago}`, detail: `Read from GitHub ${ago}` }
  }
  if (fresh.loading) return { text: 'checking…', detail: 'Reading from GitHub' }
  return { text: 'not checked yet', detail: 'No successful read from GitHub yet' }
}
