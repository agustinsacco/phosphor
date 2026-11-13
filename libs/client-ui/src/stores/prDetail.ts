import { create } from 'zustand'
import { prKey } from '@shared/github-pr-refs'
import type { GhPrDetail, GhPrKey, GhPrRef } from '@shared/models'
import { prRouteOf } from './prRoutes'

/**
 * One PR's inspector detail (`gh:prDetail`): unresolved threads, every check
 * with its workflow and annotations, and the recent timeline. Read only for
 * the PR the inspector shows, never on a background clock. A PR a Host lane
 * registered (`prRoutes.ts`) is read through that Host.
 *
 * A failed read keeps the last detail and says so; nothing here raises a toast.
 */
export interface PrDetailEntry {
  detail?: GhPrDetail
  /** Last app attempt, including failures. */
  attemptedAt: number
  loading: boolean
  /** The last attempt got no answer. */
  failed: boolean
}

/** How often an open inspector re-reads its PR while checks run (decision 7). */
export const PR_DETAIL_WATCH_MS = 30_000
/** A read this recent is reused when the inspector reopens. */
export const PR_DETAIL_FRESH_MS = 15_000

interface PrDetailState {
  byKey: Record<GhPrKey, PrDetailEntry>
  load: (ref: GhPrRef, options?: { force?: boolean }) => Promise<void>
}

const EMPTY: PrDetailEntry = Object.freeze({
  attemptedAt: 0,
  loading: false,
  failed: false,
}) as PrDetailEntry
const inFlight = new Map<GhPrKey, Promise<void>>()

export const usePrDetailStore = create<PrDetailState>((set, get) => ({
  byKey: {},

  load: (ref, options = {}) => {
    const key = prKey(ref)
    const running = inFlight.get(key)
    if (running) return running
    const current = get().byKey[key]
    if (!options.force && current && Date.now() - current.attemptedAt < PR_DETAIL_FRESH_MS)
      return Promise.resolve()
    const patch = (entry: Partial<PrDetailEntry>) =>
      set((s) => ({ byKey: { ...s.byKey, [key]: { ...(s.byKey[key] ?? EMPTY), ...entry } } }))
    patch({ loading: true })
    const work = (async () => {
      let detail: GhPrDetail | null = null
      const opts = options.force ? { force: true } : undefined
      const machine = prRouteOf(key)
      try {
        detail = await (machine
          ? window.phosphor.invoke('gh:prDetail', { ...ref }, opts, machine)
          : window.phosphor.invoke('gh:prDetail', { ...ref }, opts))
      } catch {
        // Unavailable here (a browser shell, gh missing, a Host gone): keep what is known.
      }
      const previous = get().byKey[key]?.detail
      patch({
        detail: detail ?? previous,
        attemptedAt: Date.now(),
        loading: false,
        failed: !detail,
      })
    })().finally(() => inFlight.delete(key))
    inFlight.set(key, work)
    return work
  },
}))

/** Never inline a fresh `{}` in a selector: this is the shared frozen empty entry. */
export function prDetailOf(
  state: Pick<PrDetailState, 'byKey'>,
  key: GhPrKey | undefined,
): PrDetailEntry {
  return (key && state.byKey[key]) || EMPTY
}
