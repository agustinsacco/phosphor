import { useEffect, useId, useRef } from 'react'
import { create } from 'zustand'

/**
 * The one lane selection for bulk delete, in every machine's lane list.
 *
 * Scoped to ONE folder group, never global: a group is exactly one repository
 * (worktrees fold into their main checkout), and a destructive confirm
 * spanning two repositories is how you delete the wrong branch. Selecting in
 * another group, on this machine or a Host, replaces the selection rather than
 * extending it. `keys` stay in the group's order so the confirm lists lanes
 * the way the list does.
 */
export interface LaneSelectionState {
  /** The selecting group: a local workspace path, or a Host folder's key per list. */
  group: string | null
  /** Session files on This Mac, lane ids on a Host. */
  keys: readonly string[]
  /** Anchor for shift-click ranges. */
  anchor: string | null
}

export const useLaneSelection = create<LaneSelectionState>(() => ({
  group: null,
  keys: [],
  anchor: null,
}))

const NO_KEYS: readonly string[] = Object.freeze([])

/**
 * Toggle one lane, or extend a range with shift.
 *
 * `order` is the group's lanes AFTER any search filter, so a range spans what
 * the reader can see rather than sweeping in filtered-out lanes that a bulk
 * delete would then take with it.
 */
export function nextSelection(
  current: LaneSelectionState,
  group: string,
  order: readonly string[],
  key: string,
  shiftKey: boolean,
): LaneSelectionState {
  const base = current.group === group ? current.keys : []
  const { anchor } = current
  const to = order.indexOf(key)
  if (shiftKey && anchor && order.includes(anchor) && to !== -1) {
    const from = order.indexOf(anchor)
    const range = order.slice(Math.min(from, to), Math.max(from, to) + 1)
    const merged = new Set([...base, ...range])
    return { group, keys: order.filter((k) => merged.has(k)), anchor }
  }
  const next = new Set(base)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  const keys = order.filter((k) => next.has(k))
  return keys.length ? { group, keys, anchor: key } : { group: null, keys: NO_KEYS, anchor: key }
}

export function toggleLane(
  group: string,
  order: readonly string[],
  key: string,
  shiftKey: boolean,
): void {
  useLaneSelection.setState((s) => nextSelection(s, group, order, key, shiftKey))
}

/** Replace the selection with these lanes of one group. */
export function selectLanes(group: string, keys: readonly string[]): void {
  useLaneSelection.setState({ group, keys })
}

export function clearLaneSelection(): void {
  useLaneSelection.setState({ group: null, keys: NO_KEYS, anchor: null })
}

/** The selected keys when `group` is the selecting group, else a shared frozen empty list. */
export function useSelectedKeys(group: string | null): readonly string[] {
  return useLaneSelection((s) => (group !== null && s.group === group ? s.keys : NO_KEYS))
}

/**
 * One mounted group's hold on the selection, on any machine. A folder can show
 * in two lists at once (Desktop's sidebar and Host home), so each mount keys
 * its own: `selecting` and `selected` never read another list's selection.
 */
export function useGroupSelection(groupKey: string): {
  key: string
  selecting: boolean
  selected: readonly string[]
} {
  const key = `${groupKey}@${useId()}`
  const selecting = useLaneSelection((s) => s.group === key)
  return { key, selecting, selected: useSelectedKeys(key) }
}

/** Which of `groups` is selecting, if any; another list's selection reads as null. */
export function useSelectingGroup(groups: readonly string[]): string | null {
  return useLaneSelection((s) => (s.group !== null && groups.includes(s.group) ? s.group : null))
}

/**
 * A list's hold on the selection: which of its `groups` is selecting, if any.
 *
 * Escape ends select mode, except while `paused`: a confirm is a
 * `ModalOverlay`, whose depth-aware Escape must win, or one keypress would both
 * close the dialog and drop the selection behind it. The selection lives as
 * long as the list that made it, so unmounting the list drops it.
 */
export function useSelectionOwner(groups: readonly string[], paused: boolean): string | null {
  const owned = useSelectingGroup(groups)
  const latest = useRef(groups)
  latest.current = groups
  useEffect(
    () => () => {
      const { group } = useLaneSelection.getState()
      if (group !== null && latest.current.includes(group)) clearLaneSelection()
    },
    [],
  )
  useEffect(() => {
    if (owned === null || paused) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') clearLaneSelection()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [owned, paused])
  return owned
}
