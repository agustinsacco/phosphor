import { create } from 'zustand'
import { useSessionsStore } from '@/stores/sessions'

/**
 * The sidebar's explicit collapse choices, for This Mac's workspace groups
 * (keyed by workspace path) and Host folders (`remoteLaneGroupKey`) alike, in
 * the one `collapsedWorkspaces` pref. One store, because the pref is written
 * whole: two owners would each overwrite the other's keys.
 *
 * `collapsed` is null until the pref is read. Only collapsed groups persist; an
 * explicit expand lasts for this run.
 */
export const useGroupCollapse = create<{ collapsed: Record<string, boolean> | null }>(() => ({
  collapsed: null,
}))

/** Keys chosen in this run: a later read of the pref never undoes them. */
const chosen = new Set<string>()
let reading: Promise<void> | null = null

/** Read the pref. Every call re-reads; a choice made in this run wins over the stored one. */
export function loadGroupCollapse(): Promise<void> {
  const apply = (saved: readonly string[]): void => {
    const current = useGroupCollapse.getState().collapsed ?? {}
    const stored: Record<string, boolean> = Object.fromEntries(saved.map((key) => [key, true]))
    for (const key of chosen) stored[key] = current[key] ?? false
    useGroupCollapse.setState({ collapsed: stored })
    if (reading === read) reading = null
  }
  // An unreadable pref (or none) means nothing is collapsed yet.
  const read: Promise<void> = Promise.resolve(window.phosphor?.invoke('app:getPrefs')).then(
    (prefs) => apply(prefs?.collapsedWorkspaces ?? []),
    () => apply([]),
  )
  reading = read
  return read
}

/** Settles once the pref has been read: the read in flight, or a first one. */
function whenRead(): Promise<void> {
  if (reading) return reading
  return useGroupCollapse.getState().collapsed === null ? loadGroupCollapse() : Promise.resolve()
}

let orderRead: Promise<void> | null = null

/**
 * Read the sidebar prefs (collapse once, lane order on each mount) for a list
 * that does not own This Mac's sidebar: a Host folder anywhere, including the
 * browser, where no sidebar reads them. Folders mounting together share one read.
 */
export function ensureSidebarPrefs(): void {
  void whenRead()
  orderRead ??= useSessionsStore
    .getState()
    .hydratePinned()
    .catch(() => undefined)
    .finally(() => {
      orderRead = null
    })
}

export function setGroupCollapsed(key: string, collapsed: boolean): void {
  // The pref is replaced whole, so it is written only once it has been read.
  const read = whenRead()
  chosen.add(key)
  useGroupCollapse.setState((s) => ({ collapsed: { ...(s.collapsed ?? {}), [key]: collapsed } }))
  void read.then(() => {
    const next = useGroupCollapse.getState().collapsed ?? {}
    return window.phosphor
      .invoke(
        'app:setCollapsedWorkspaces',
        Object.keys(next).filter((k) => next[k]),
      )
      .catch(() => undefined)
  })
}
