/**
 * Which Claude account a live session was spawned onto.
 *
 * A session's account is decided at spawn, but the thing it has to be recorded
 * against — the session's own `.jsonl` path — does not exist yet: pi writes the
 * file when the first turn ends, and the renderer only learns the path from
 * `get_state`. So the pick is parked here under the pidex session id and
 * claimed by `claude:bindSession` once the path is known.
 *
 * Deliberately not persisted. An entry for a session disposed before its
 * first turn dies with the process, and the binding it would have written is
 * one no resume will ever look for.
 */
const bySession = new Map<string, string>()

/** Record the account a spawn chose, keyed by pidex session id. */
export function rememberSpawnAccount(pidexSessionId: string, accountId: string): void {
  bySession.set(pidexSessionId, accountId)
}

/**
 * Read it without consuming it.
 *
 * The pick used to be claimed (read-and-delete) by `claude:bindSession`, which
 * left the main process unable to answer "which account is this session on?"
 * for the rest of the session's life — the very question the context popover
 * asks, and the one that decides whose usage it should show. The entry now
 * lives until the subprocess goes away and `forgetSpawnAccount` clears it.
 */
export function spawnAccountFor(pidexSessionId: string): string | undefined {
  return bySession.get(pidexSessionId)
}

/** Drop a session's parked pick when its subprocess goes away. */
export function forgetSpawnAccount(pidexSessionId: string): void {
  bySession.delete(pidexSessionId)
}

/**
 * Every live pick, grouped account id → session ids.
 *
 * The gateway view in Settings asks "who is spending this account right now",
 * and this map is the only place that knows: `bindings` is keyed by session
 * FILE, so it cannot say which of them are running.
 */
export function spawnAccountSessions(): Record<string, string[]> {
  const grouped: Record<string, string[]> = {}
  for (const [sessionId, accountId] of bySession) {
    ;(grouped[accountId] ??= []).push(sessionId)
  }
  return grouped
}
