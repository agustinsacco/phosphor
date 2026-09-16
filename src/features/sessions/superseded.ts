import type { SessionMeta } from '@shared/models'

/**
 * Set key for "this file, branched at this entry".
 *
 * Keyed on the FILE NAME, not the recorded path. `parentSession` is an
 * absolute path frozen at write time, and renaming a workspace folder moves
 * the whole transcript directory — so every recorded parent then names a
 * directory that no longer exists, no link in the chain matches, and every
 * abandoned rewind parent comes back as its own row. That is what produced
 * five identical "Single-Player StarCraft Clone" rows after sandbox-1 was
 * renamed to games. Names are `TIMESTAMP_UUID.jsonl` and these metas are one
 * folder's scan, so the name identifies the file either way.
 */
const fileName = (sessionPath: string): string => sessionPath.split(/[/\\]/).pop() ?? sessionPath
const key = (sessionPath: string, entryId: string): string =>
  `${fileName(sessionPath)}\u0000${entryId}`

/**
 * Drop session files that a rewind left behind.
 *
 * pi's `fork` RPC — the one mechanism behind the per-message rewind button,
 * the fork picker and `clone` — never truncates a session in place. It copies
 * the entries up to the branch point into a brand-new `TIMESTAMP_ID.jsonl`,
 * moves the live runtime onto it, and abandons the original
 * (`createBranchedSession` in pi's `session-manager.js`). The abandoned file
 * stays on disk, so the sidebar showed two rows with the same name in the same
 * worktree after every rewind, which read as the lane having duplicated
 * itself. PR #144 fixed which of the two was marked live; this removes the
 * dead one.
 *
 * A branch is identified by BOTH halves, because `parentSession` alone is
 * ambiguous — pi records it for a plain successor session (`/new`) too, and
 * hiding the predecessor of a `/new` would delete real history from the
 * sidebar. Only a branch repeats its parent's first entry id, since only a
 * branch copies those entries.
 *
 * The file itself is untouched: this is presentation. Deleting a session
 * stays the user's call, and the bytes are still there for anyone who goes
 * looking.
 *
 * A LIVE session is never dropped. `bootstrapSession` relearns the branch's
 * path asynchronously, so for a moment after a rewind the abandoned file is
 * still the one a pi subprocess is claimed to own — hiding the row the user
 * is looking at, even briefly, is worse than showing one extra.
 */
export function dropSupersededSessions(
  metas: SessionMeta[],
  isLive: (meta: SessionMeta) => boolean = () => false,
): SessionMeta[] {
  const superseded = new Set<string>()
  for (const child of metas) {
    if (!child.parentSession || !child.firstEntryId) continue
    superseded.add(key(child.parentSession, child.firstEntryId))
  }
  if (superseded.size === 0) return metas
  return metas.filter(
    (m) => !m.firstEntryId || !superseded.has(key(m.path, m.firstEntryId)) || isLive(m),
  )
}
