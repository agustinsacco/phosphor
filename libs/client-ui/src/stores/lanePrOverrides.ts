import { create } from 'zustand'
import { prKey } from '@shared/github-pr-refs'
import type { GhPrKey, GhPrRef, LanePrSignals } from '@shared/models'
import type { LanePrOverride } from '@/features/sessions/lanePrOverrides'

/**
 * Track and Hide, shown before the session scan reads them back.
 *
 * `setLanePrOverride` writes a `phosphor-prs` entry through the lane's pi, but
 * the sidebar and the inspector read the lane's PRs from the scanned session
 * file, which lags. Each write is recorded here by session file path the moment
 * pi accepts it and merged into the scanned signals until the scan agrees, or
 * for `LANE_PR_OVERRIDE_TTL_MS` when it never does (a write pi refused).
 */
export const LANE_PR_OVERRIDE_TTL_MS = 120_000

export interface LanePrOverrideMark {
  key: GhPrKey
  ref: GhPrRef
  action: LanePrOverride
  at: number
}

const EMPTY_SIGNALS: LanePrSignals = {
  opened: [],
  branches: [],
  reviewing: [],
  mentioned: [],
  pinned: [],
  hidden: [],
}

const without = (refs: GhPrRef[], key: GhPrKey): GhPrRef[] =>
  refs.filter((ref) => prKey(ref) !== key)

/** One pin, hide or clear applied to a lane's signals, as the fold would read it. */
export function applyLanePrOverride(
  signals: LanePrSignals | undefined,
  action: LanePrOverride,
  ref: GhPrRef,
): LanePrSignals {
  const base = signals ?? EMPTY_SIGNALS
  const key = prKey(ref)
  const pinned = without(base.pinned, key)
  const hidden = without(base.hidden, key)
  if (action === 'pin') pinned.push(ref)
  if (action === 'hide') hidden.push(ref)
  return { ...base, pinned, hidden }
}

/** The scanned signals with every recorded mark applied. Unchanged when there are none. */
export function mergeLanePrOverrides(
  signals: LanePrSignals | undefined,
  marks: readonly LanePrOverrideMark[] | undefined,
): LanePrSignals | undefined {
  if (!marks?.length) return signals
  return marks.reduce<LanePrSignals | undefined>(
    (merged, mark) => applyLanePrOverride(merged, mark.action, mark.ref),
    signals,
  )
}

/** Whether the scanned signals already say what the mark asked for. */
export function lanePrOverrideSettled(
  signals: LanePrSignals | undefined,
  mark: LanePrOverrideMark,
): boolean {
  const has = (refs: GhPrRef[] | undefined) => !!refs?.some((ref) => prKey(ref) === mark.key)
  const pinned = has(signals?.pinned)
  const hidden = has(signals?.hidden)
  if (mark.action === 'pin') return pinned && !hidden
  if (mark.action === 'hide') return hidden && !pinned
  return !pinned && !hidden
}

interface LanePrOverridesState {
  /** Marks per session file path, in write order, at most one per PR. */
  byPath: Record<string, LanePrOverrideMark[]>
  record: (path: string, action: LanePrOverride, ref: GhPrRef, at?: number) => void
  /** Drop the marks the scanned signals agree with. */
  settle: (path: string, signals: LanePrSignals | undefined) => void
  /** Drop one mark if it is still the one recorded `at`. */
  expire: (path: string, key: GhPrKey, at: number) => void
}

function replaceMarks(
  byPath: Record<string, LanePrOverrideMark[]>,
  path: string,
  marks: LanePrOverrideMark[],
): Record<string, LanePrOverrideMark[]> {
  const next = { ...byPath }
  if (marks.length) next[path] = marks
  else delete next[path]
  return next
}

export const useLanePrOverridesStore = create<LanePrOverridesState>((set, get) => ({
  byPath: {},
  record: (path, action, ref, at = Date.now()) => {
    const key = prKey(ref)
    const marks = (get().byPath[path] ?? []).filter((mark) => mark.key !== key)
    set({ byPath: replaceMarks(get().byPath, path, [...marks, { key, ref, action, at }]) })
    setTimeout(() => get().expire(path, key, at), LANE_PR_OVERRIDE_TTL_MS)
  },
  settle: (path, signals) => {
    const marks = get().byPath[path]
    if (!marks) return
    const open = marks.filter((mark) => !lanePrOverrideSettled(signals, mark))
    if (open.length !== marks.length) set({ byPath: replaceMarks(get().byPath, path, open) })
  },
  expire: (path, key, at) => {
    const marks = get().byPath[path]
    if (!marks?.some((mark) => mark.key === key && mark.at === at)) return
    set({
      byPath: replaceMarks(
        get().byPath,
        path,
        marks.filter((mark) => mark.key !== key),
      ),
    })
  },
}))
