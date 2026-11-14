import { create } from 'zustand'
import type { GhPrCheck, GhPrKey, GhPrSummary } from '@shared/models'

/**
 * What each pull request looked like the last time you looked at it in the
 * inspector: the baseline for its "Since you looked" line and for highlighting
 * newer activity. Kept per PR, not per lane, so a PR two lanes share has one
 * baseline.
 *
 * Persisted in localStorage, bounded to the most recent `PR_SEEN_MAX` PRs. A
 * missing, corrupt or full store only loses the baseline, never the inspector.
 */
export interface PrSeenEntry {
  /** Only what `prChanges` reads; passing checks are dropped to keep this small. */
  summary: GhPrSummary
  seenAt: number
}

export const PR_SEEN_MAX = 200
const STORAGE_KEY = 'phosphor-pr-seen-v1'

interface PrSeenState {
  byKey: Record<GhPrKey, PrSeenEntry>
  record: (key: GhPrKey, summary: GhPrSummary, at?: number) => void
}

/** `prChanges` and `mergeBlock` read failing and running checks, never passing ones. */
export function seenSnapshot(summary: GhPrSummary): GhPrSummary {
  const keep = (check: GhPrCheck): GhPrCheck => ({
    name: check.name,
    state: check.state,
    required: check.required,
  })
  return {
    ...summary,
    checkRuns:
      summary.checkRuns?.filter((c) => c.state === 'failure' || c.state === 'pending').map(keep) ??
      null,
  }
}

const isEntry = (value: unknown): value is PrSeenEntry => {
  const entry = value as PrSeenEntry | null
  return (
    !!entry &&
    typeof entry === 'object' &&
    typeof entry.seenAt === 'number' &&
    !!entry.summary &&
    typeof entry.summary === 'object' &&
    typeof entry.summary.state === 'string' &&
    Array.isArray(entry.summary.approvedBy) &&
    Array.isArray(entry.summary.changesRequestedBy)
  )
}

export function loadPrSeen(): Record<GhPrKey, PrSeenEntry> {
  try {
    const raw: unknown = JSON.parse(globalThis.localStorage?.getItem(STORAGE_KEY) ?? '{}')
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
    return Object.fromEntries(Object.entries(raw).filter(([, entry]) => isEntry(entry)))
  } catch {
    return {}
  }
}

/** The newest `PR_SEEN_MAX`, by when each was seen. */
export function boundPrSeen(byKey: Record<GhPrKey, PrSeenEntry>): Record<GhPrKey, PrSeenEntry> {
  const entries = Object.entries(byKey)
  if (entries.length <= PR_SEEN_MAX) return byKey
  return Object.fromEntries(
    entries.sort(([, a], [, b]) => b.seenAt - a.seenAt).slice(0, PR_SEEN_MAX),
  )
}

function save(byKey: Record<GhPrKey, PrSeenEntry>): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(byKey))
  } catch {
    // A full or blocked store loses the baseline, nothing else.
  }
}

export const usePrSeenStore = create<PrSeenState>((set, get) => ({
  byKey: loadPrSeen(),
  record: (key, summary, at = Date.now()) => {
    const byKey = boundPrSeen({
      ...get().byKey,
      [key]: { summary: seenSnapshot(summary), seenAt: at },
    })
    set({ byKey })
    save(byKey)
  },
}))
