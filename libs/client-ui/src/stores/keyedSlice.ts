/**
 * The keyed-slice pattern the stores share.
 *
 * Most stores here are `Record<key, Slice>` projections of main-process state
 * (files and terminals per workspace/session, panes per session, worktrees per
 * repo, chat per session). Each had independently grown the same three parts:
 * a default value returned for keys that have no slice yet, a `patch` that
 * creates the slice on first write, and a reader used from selectors. This is
 * that trio, once.
 *
 * Stores keep their own exported accessors (`workspaceFiles`,
 * `sessionTerminals`, `sessionPanes`, `repoWorktrees`) as thin wrappers over
 * `read` — those names are the store API, and CLAUDE.md fact 5 is written in
 * terms of them.
 */

/** The read/patch pair for one `Record<string, S>` store field. */
export interface KeyedSlice<S> {
  /** A key's slice, or the default when it has none yet. */
  read: (map: Record<string, S>, key: string | null | undefined) => S
  /** Apply an update to one key's slice, creating it from the default if absent. */
  patch: (map: Record<string, S>, key: string, update: (current: S) => S) => Record<string, S>
}

/**
 * Slice helpers over ONE shared, frozen empty value (`empty` is frozen in
 * place, so a module-level const passed in here stays usable as the store's
 * empty literal).
 *
 * Sharing is the point: `read` is called from selectors, and returning a fresh
 * `{}` per render would re-render every subscriber forever. Freezing is what
 * keeps that safe — the same object reaches every keyless reader, so a mutation
 * would corrupt all of them.
 */
export function keyedSlice<S extends object>(empty: S): KeyedSlice<S> {
  const frozen = Object.freeze(empty)
  return sliceWith(() => frozen)
}

/**
 * Slice helpers whose default is built fresh on every miss.
 *
 * For slices that own mutable state: `chat.ts`'s `ChatSession` carries the item
 * arrays the reducer appends to, so handing every session one frozen singleton
 * would be a real bug rather than an optimisation. The trade is that `read`
 * allocates on a miss, so keep these out of render-path selectors.
 */
export function keyedSliceFrom<S extends object>(create: () => S): KeyedSlice<S> {
  return sliceWith(create)
}

function sliceWith<S>(fallback: () => S): KeyedSlice<S> {
  return {
    read: (map, key) => (key ? map[key] : undefined) ?? fallback(),
    patch: (map, key, update) => ({ ...map, [key]: update(map[key] ?? fallback()) }),
  }
}

/**
 * A copy of `map` without `key` — or `map` itself when the key is absent, so
 * callers can keep state identity (and their subscribers asleep) on a no-op.
 *
 * Free-standing rather than a `KeyedSlice` method because the records that need
 * it are mostly not slices: disposing a session drops it from four artifact
 * records and three session records, and forgetting one of them is exactly the
 * leak the comments at those call sites record.
 */
export function drop<T>(map: Record<string, T>, key: string): Record<string, T> {
  if (!(key in map)) return map
  const next = { ...map }
  delete next[key]
  return next
}
