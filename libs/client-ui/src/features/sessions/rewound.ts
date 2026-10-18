/**
 * Which session files a rewind replaced, and what replaced them.
 *
 * pi never edits a session file in place: its `fork` command copies the
 * branch into a new `TIMESTAMP_UUID.jsonl` and moves the running session onto
 * it, leaving the old file on disk. After a rewind that read as the chat
 * having duplicated itself, two rows with one title, and a user who reopened
 * the old one ran a second agent in the same worktree.
 *
 * The files alone cannot tell a rewind from a deliberate fork or clone (they
 * have the same shape, which is why the content-based guess of #153 was
 * removed in #331). So the decision is made by the ACTION: `rewindToEntry`
 * records `old → new` here, and nothing else does. Rewinds from before the
 * record existed stay visible on purpose.
 *
 * Keyed by FILE NAME, never by path. Renaming a workspace folder moves its
 * whole transcript directory, and a path-keyed record stopped matching (the
 * five identical rows of #267). The name is a timestamp plus a UUID, unique on
 * its own.
 */
export type RewoundSessions = Record<string, string>

export function sessionFileName(sessionPath: string): string {
  return sessionPath.split(/[/\\]/).pop() ?? sessionPath
}

/** Record that a rewind moved the session at `fromPath` onto `toPath`. */
export function withRewind(
  record: RewoundSessions,
  fromPath: string,
  toPath: string,
): RewoundSessions {
  const from = sessionFileName(fromPath)
  const to = sessionFileName(toPath)
  if (from === to) return record
  const next = { ...record, [from]: to }
  // A successor never replaces its own ancestor; refuse to close a loop.
  delete next[to]
  return next
}

/**
 * Forget the link OUT of one file, because a turn ended in it: the user
 * reopened an old version and carried on, so it is a chat of its own again and
 * must not fold away under a version that is now older than its own work.
 * Links INTO it stay, so whatever it replaced remains folded under it.
 */
export function withoutRewindOf(record: RewoundSessions, sessionPath: string): RewoundSessions {
  const name = sessionFileName(sessionPath)
  if (!(name in record)) return record
  const next = { ...record }
  delete next[name]
  return next
}

/**
 * Every file name a rewind's successor can be found under: each scanned file,
 * plus each live session's file. pi writes a rewound branch with no reply yet
 * only when its next turn ends, so for that whole turn the live session (shown
 * by its placeholder row) is the successor's only trace. Counting it is what
 * stops the old row from sitting there, unmarked, inviting a second agent.
 * Once the process is gone, so is the entry, and an unwritten successor
 * brings the old row back: the chat never ends up with no row at all.
 */
export function presentSessionFiles(
  disk: Record<string, ReadonlyArray<{ path: string }>>,
  livePaths: Iterable<string | undefined>,
): Set<string> {
  const present = new Set<string>()
  for (const metas of Object.values(disk)) {
    for (const meta of metas) present.add(sessionFileName(meta.path))
  }
  for (const path of livePaths) if (path) present.add(sessionFileName(path))
  return present
}

/**
 * Forget a deleted file, keeping its chain intact: after A → B → C, deleting
 * B leaves A → C, so A stays folded under the version that carries on.
 */
export function withoutSession(record: RewoundSessions, sessionPath: string): RewoundSessions {
  const name = sessionFileName(sessionPath)
  const successor = record[name]
  let changed = name in record
  const next: RewoundSessions = {}
  for (const [from, to] of Object.entries(record)) {
    if (from === name) continue
    if (to === name) {
      changed = true
      if (successor && successor !== from) next[from] = successor
      continue
    }
    next[from] = to
  }
  return changed ? next : record
}

/**
 * The latest version of a rewound file that is actually on disk, or null.
 *
 * Follows the chain to its end (A → B → C answers C) and skips links whose
 * file is gone, so a missing successor never hides anything. The visited set
 * guards against a hand-edited cycle.
 */
export function latestRewoundVersion(
  record: RewoundSessions,
  sessionPath: string,
  present: ReadonlySet<string>,
): string | null {
  const seen = new Set([sessionFileName(sessionPath)])
  let latest: string | null = null
  let current = record[sessionFileName(sessionPath)]
  while (current) {
    if (seen.has(current)) return null
    seen.add(current)
    if (present.has(current)) latest = current
    current = record[current]
  }
  return latest
}
