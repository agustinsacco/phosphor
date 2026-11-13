import { create } from 'zustand'
import { PR_SUMMARY_BATCH_SIZE, prKey } from '@shared/github-pr-refs'
import type { GhBranchCoverage, GhPrKey, GhPrRead, GhPrRef, GhPrSummary } from '@shared/models'

/**
 * Pull-request status by PR, read by number (`gh:prSummaries`). Branch
 * discovery (`pullRequests.ts`) still finds which PR a branch has; this holds
 * what each PR looks like now, wherever it lives.
 *
 * Same rules as discovery: a failure keeps the last known status and marks it
 * stale, only GitHub saying a PR does not exist removes it, and nothing here
 * raises a toast.
 */
export interface PrStatusEntry {
  summary?: GhPrSummary
  coverage?: GhBranchCoverage
  /** Last app attempt, including failures. */
  attemptedAt: number
  /** Last app attempt that returned an answer. */
  fetchedAt: number
  /** The last attempt got no answer at all. */
  failed?: boolean
}

/** Default and watched cadences. A lane with running checks is read every 30s while it's in view. */
export const PR_STATUS_STALE_MS = 60_000
export const PR_STATUS_WATCH_MS = 30_000

interface PrStatusState {
  byKey: Record<GhPrKey, PrStatusEntry>
  /** Refresh PRs older than `staleMs`. Merged and closed PRs are read once per app run. */
  refresh: (refs: GhPrRef[], options?: { force?: boolean; staleMs?: number }) => Promise<void>
}

const EMPTY: PrStatusEntry = Object.freeze({ attemptedAt: 0, fetchedAt: 0 }) as PrStatusEntry
const inFlight = new Set<GhPrKey>()

export const isTerminal = (summary: GhPrSummary | undefined): boolean =>
  summary?.state === 'MERGED' || summary?.state === 'CLOSED'

export function prStatusDue(
  entry: PrStatusEntry | undefined,
  staleMs: number,
  now: number,
): boolean {
  if (!entry?.attemptedAt) return true
  if (isTerminal(entry.summary) || entry.coverage?.state === 'absent') return false
  return now - entry.attemptedAt >= staleMs
}

function merge(
  current: PrStatusEntry | undefined,
  key: GhPrKey,
  read: GhPrRead | null,
  now: number,
): PrStatusEntry {
  const base = current ?? EMPTY
  if (!read) return { ...base, attemptedAt: now, failed: true }
  const coverage = read.coverage[key]
  const summary = coverage?.state === 'absent' ? undefined : (read.byKey[key] ?? base.summary)
  return { summary, coverage, attemptedAt: now, fetchedAt: now, failed: false }
}

export const usePrStatusStore = create<PrStatusState>((set, get) => ({
  byKey: {},

  refresh: async (refs, options = {}) => {
    const now = Date.now()
    const staleMs = options.staleMs ?? PR_STATUS_STALE_MS
    const seen = new Set<GhPrKey>()
    const due = refs
      .filter((ref) => {
        const key = prKey(ref)
        if (seen.has(key) || inFlight.has(key)) return false
        seen.add(key)
        return options.force || prStatusDue(get().byKey[key], staleMs, now)
      })
      // Keep one repository's PRs together: main reads each repository in one query.
      .sort((a, b) => prKey(a).localeCompare(prKey(b)))
    for (let i = 0; i < due.length; i += PR_SUMMARY_BATCH_SIZE) {
      const page = due.slice(i, i + PR_SUMMARY_BATCH_SIZE)
      const keys = page.map(prKey)
      for (const key of keys) inFlight.add(key)
      let read: GhPrRead | null = null
      try {
        read = await window.phosphor.invoke(
          'gh:prSummaries',
          page,
          options.force ? { force: true } : undefined,
        )
      } catch {
        // Unavailable here (a browser shell, or gh missing): keep what is known.
      } finally {
        for (const key of keys) inFlight.delete(key)
      }
      const at = Date.now()
      set((s) => {
        const byKey = { ...s.byKey }
        for (const key of keys) byKey[key] = merge(s.byKey[key], key, read, at)
        return { byKey }
      })
    }
  },
}))

/** Never inline a fresh `{}` in a selector: this is the shared frozen empty entry. */
export function prStatusOf(
  state: Pick<PrStatusState, 'byKey'>,
  key: GhPrKey | undefined,
): PrStatusEntry {
  return (key && state.byKey[key]) || EMPTY
}
