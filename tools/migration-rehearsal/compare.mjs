import { isDeepStrictEqual } from 'node:util'

/** Top-level config keys whose values differ. Names only: values can hold paths and drafts. */
export function changedKeys(live, saved) {
  const keys = new Set([...Object.keys(saved ?? {}), ...Object.keys(live ?? {})])
  return [...keys].filter((k) => !isDeepStrictEqual(live?.[k], saved?.[k])).sort()
}

const count = (value) =>
  Array.isArray(value)
    ? value.length
    : value && typeof value === 'object'
      ? Object.keys(value).length
      : 0

/**
 * What a restore must give back exactly: the folder list and the Claude accounts. Drafts may
 * shrink only by images no longer on disk, so they are counted, not compared.
 */
export function restoredConfig(live, saved) {
  return {
    folders: isDeepStrictEqual(live?.recentWorkspaces, saved?.recentWorkspaces),
    accounts: isDeepStrictEqual(live?.claudeAccounts, saved?.claudeAccounts),
    counts: {
      folders: count(saved?.recentWorkspaces),
      accounts: count(saved?.claudeAccounts),
      draftsSaved: count(saved?.drafts),
      draftsLive: count(live?.drafts),
    },
    changed: changedKeys(live, saved),
  }
}

/** Conversations are never moved: every transcript must still exist and never shrink. */
export function sessionsKept(before, after) {
  let missing = 0,
    shrunk = 0,
    grew = 0
  for (const [name, size] of before) {
    const now = after.get(name)
    if (now === undefined) missing++
    else if (now < size) shrunk++
    else if (now > size) grew++
  }
  const added = [...after.keys()].filter((name) => !before.has(name)).length
  return { files: before.size, missing, shrunk, grew, added, kept: missing === 0 && shrunk === 0 }
}
