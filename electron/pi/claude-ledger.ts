import { shell } from 'electron'
import { randomUUID } from 'node:crypto'
import { access, copyFile, readFile, rm, writeFile } from 'node:fs/promises'
import type { ClaudeContextReset } from '@shared/models'
import { claudeSessionFileForCwd } from './pi-paths'
import { readSessionMap, sessionMapPath, storedPromptPath } from './claude-session-map'

/**
 * The two writes Phosphor makes to `pi-claude-cli`'s sidecar map: pairing a
 * cloned pi session with its own CLI session, and un-pairing one whose CLI
 * session can no longer be resumed.
 *
 * The sidecar belongs to the provider, and a parked CLI process can write it
 * concurrently. So `claude-session-map.ts` stays read-only, this module is the
 * one sanctioned writer, and both operations keep the window between reading
 * the map and rewriting it as short as they can — a whole-map write is the
 * only shape the file supports, so anything the provider recorded inside that
 * window is lost. Every failure mode here lands on the same safe outcome: no
 * entry for the pi session, and the provider reimports pi's history on the
 * next turn.
 */

interface PiSessionHeader {
  id?: string
  cwd?: string
  parentSession?: string
}

/** First line of a pi session file, or null when it isn't a session header. */
async function readPiHeader(path: string): Promise<PiSessionHeader | null> {
  try {
    const raw = await readFile(path, 'utf-8')
    const newlineIndex = raw.indexOf('\n')
    const firstLine = newlineIndex === -1 ? raw : raw.slice(0, newlineIndex)
    const header = JSON.parse(firstLine) as Record<string, unknown>
    if (header.type !== 'session') return null
    return header as PiSessionHeader
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Fork — pair a cloned pi session with a copy of its parent's CLI transcript
// ---------------------------------------------------------------------------

/**
 * Copy a CLI transcript under a new session id. Lines are JSON objects with a
 * top-level `sessionId`; anything that doesn't parse is copied verbatim (the
 * CLI's own reader skips what it can't parse, so preserving bytes beats
 * dropping evidence). Split on LF only — never `readline`, whose extra split
 * points corrupt a rewrite instead of just failing a read.
 */
async function copyLedgerAs(
  sourcePath: string,
  targetPath: string,
  oldCliId: string,
  newCliId: string,
): Promise<void> {
  const raw = await readFile(sourcePath, 'utf-8')
  const rewritten = raw
    .split('\n')
    .map((line) => {
      if (!line.trim()) return line
      try {
        const entry = JSON.parse(line) as Record<string, unknown>
        if (entry.sessionId === oldCliId) entry.sessionId = newCliId
        return JSON.stringify(entry)
      } catch {
        return line
      }
    })
    .join('\n')
  // `wx`: a fresh UUID colliding with an existing transcript means something
  // is very wrong — refuse rather than overwrite another session's ledger.
  await writeFile(targetPath, rewritten, { encoding: 'utf-8', flag: 'wx' })
}

/**
 * Fork the Claude CLI ledger for a freshly cloned pi session, given the
 * CLONE's session file. Returns true when the clone was paired with a forked
 * CLI session, false when there was nothing to do (not a Claude session, no
 * parent, ledger already gone) — false is normal, not an error.
 *
 * pi's `clone` RPC branches a session at the leaf onto a new file with a NEW
 * pi session id, which misses the provider's map, so the clone's first turn
 * reimports the entire conversation into a fresh CLI session — a full-context
 * cache write (measured: 64k tokens on a 100k-token session, 2026-09-07) and
 * a discarded cached prefix, for what the user experienced as "continue where
 * I was".
 *
 * Pointing the clone at the SAME CLI session is not an option: the original
 * survives a clone, and two pi sessions resuming one CLI session would append
 * both conversations to a single transcript and leak turns across. So this
 * does on disk what `claude --fork-session` does: copy the CLI transcript
 * under a fresh session id, carry the provider's stored system prompt with
 * it, and record the new pairing.
 *
 * Known gap: the original's `<cliSessionId>/` sidecar directory (oversized
 * tool results) is not copied. A forked transcript that references those by
 * path loses them — same trade `claude --fork-session` makes.
 */
export async function forkClaudeLedgerForClone(cloneSessionFile: string): Promise<boolean> {
  const cloneHeader = await readPiHeader(cloneSessionFile)
  if (!cloneHeader?.id || !cloneHeader.cwd || !cloneHeader.parentSession) return false

  const parentHeader = await readPiHeader(cloneHeader.parentSession)
  if (!parentHeader?.id) return false

  const map = await readSessionMap()
  const oldCliId = map[parentHeader.id]
  // No pairing for the parent: not a pi-claude-cli session (or it never
  // finished a turn). Already a pairing for the clone: the provider ran a
  // turn before we got here and created its own CLI session — respect it.
  if (!oldCliId || map[cloneHeader.id]) return false

  const oldLedger = claudeSessionFileForCwd(cloneHeader.cwd, oldCliId)
  const newCliId = randomUUID()
  const newLedger = claudeSessionFileForCwd(cloneHeader.cwd, newCliId)
  try {
    await copyLedgerAs(oldLedger, newLedger, oldCliId, newCliId)
  } catch {
    // Most commonly ENOENT: the parent's ledger was deleted. Reimport it is.
    return false
  }

  // The stored system prompt is what the provider replays verbatim on every
  // resume of a CLI session; without it the fork falls back to rebuilding
  // the prompt, which is less cache-stable. Best-effort — absence only costs
  // cache bytes, never correctness.
  try {
    await copyFile(storedPromptPath(oldCliId), storedPromptPath(newCliId))
  } catch {
    // No stored prompt (pre-0.7 session) — the fallback handles it.
  }

  // Re-read before writing to shrink the race against a provider that wrote
  // the map between our check and now; if it won, its CLI session is the one
  // the clone is already talking to, so ours is the orphan to discard.
  const freshMap = await readSessionMap()
  if (!freshMap[cloneHeader.id]) {
    freshMap[cloneHeader.id] = newCliId
    try {
      await writeFile(sessionMapPath(), JSON.stringify(freshMap, null, 2), 'utf-8')
      return true
    } catch {
      // Fall through to cleanup: an unrecorded fork is just an orphan.
    }
  }
  await Promise.allSettled([
    rm(newLedger, { force: true }),
    rm(storedPromptPath(newCliId), { force: true }),
  ])
  return false
}

// ---------------------------------------------------------------------------
// Reset — un-pair a pi session whose CLI transcript can no longer be resumed
// ---------------------------------------------------------------------------

/**
 * Drop a pi session's pairing with its Claude Code CLI session, so the next
 * turn reimports pi's history into a fresh one.
 *
 * This is the recovery for `ContextPolicyError`: the provider stores the
 * system prompt each CLI session was created with, and refuses to resume one
 * whose stored prompt was written under the other context policy
 * (`PI_CLAUDE_CLI_CONTEXT`) rather than splice two sets of instructions into
 * one transcript. Every Claude session started before Phosphor took ownership
 * of context (2026-09-09) is stamped `legacy`, so it throws on the first turn
 * after an upgrade — with no way out from inside the session, because the
 * check runs before the model does and the message never reaches an API call.
 *
 * pi is the system of record and the CLI transcript is derived, so dropping
 * the pairing loses no conversation: the provider treats the next turn as a
 * first turn and replays pi's full history. The cost is exactly one turn
 * billed as a cache WRITE over the whole conversation instead of a cache read
 * — the same trade the fork above exists to avoid, taken deliberately here
 * because the alternative is a session that cannot take another message.
 *
 * The orphaned CLI transcript is trashed rather than unlinked (the stance
 * `session-deleter.ts` takes) and only when nothing else points at it: the
 * reimport writes a second, complete copy, and `deleteSession` will only ever
 * find that newer one.
 */
export async function resetClaudeLedgerPairing(
  sessionFilePath: string,
): Promise<ClaudeContextReset> {
  const header = await readPiHeader(sessionFilePath)
  if (!header?.id) return { cleared: false, claudeSessionId: null }

  // Read and write with nothing awaited in between: a parked CLI process owns
  // this file too, and the shorter the window the fewer of its pairings a
  // whole-map rewrite can clobber. Everything else waits until after the write.
  const map = await readSessionMap()
  const cliId = map[header.id]
  // Nothing to un-pair. Not a failure: the next turn already reimports, which
  // is the state this function exists to reach.
  if (!cliId) return { cleared: false, claudeSessionId: null }
  delete map[header.id]
  // The one step that must land. A failure here leaves the session exactly as
  // it was, so it surfaces to the user rather than being swallowed.
  await writeFile(sessionMapPath(), JSON.stringify(map, null, 2), 'utf-8')

  // The stored prompt is what made the resume illegal; nothing reads it once
  // the pairing is gone. Best-effort from here — the recovery has landed.
  await Promise.allSettled([
    rm(storedPromptPath(cliId), { force: true }),
    trashOrphanedLedger(map, header.cwd, cliId),
  ])

  return { cleared: true, claudeSessionId: cliId }
}

// ---------------------------------------------------------------------------
// Forget — drop a deleted pi session's pairing and stored prompt
// ---------------------------------------------------------------------------

/**
 * Remove a deleted pi session from the provider's sidecar, returning the CLI
 * session id it was paired with (null when there was no pairing) and whether
 * another pi session still points at that CLI session.
 *
 * Deleting a session used to trash both transcripts and leave this
 * bookkeeping behind: a map entry and a stored system prompt (~7 KB) per
 * session ever deleted — 727 dead entries of 794 on one install. Nothing reads
 * either once the pi session is gone, and the map is rewritten whole on every
 * pairing, so it only grows.
 *
 * Same read-then-write discipline as the reset above. The caller has already
 * stopped every process that could own the pi session, so no provider write
 * for THIS entry can race us; one for another session can, and the short
 * window is what limits it. Unlike the reset, a failed write is swallowed:
 * the delete itself has already landed, and a stale entry is only clutter.
 */
export async function forgetClaudePairing(
  piSessionId: string,
): Promise<{ cliSessionId: string | null; shared: boolean }> {
  const map = await readSessionMap()
  const cliId = map[piSessionId]
  if (!cliId) return { cliSessionId: null, shared: false }
  delete map[piSessionId]
  try {
    await writeFile(sessionMapPath(), JSON.stringify(map, null, 2), 'utf-8')
  } catch {
    // Clutter, not corruption — carry on with the rest of the delete.
  }
  const shared = Object.values(map).includes(cliId)
  if (!shared) await rm(storedPromptPath(cliId), { force: true }).catch(() => undefined)
  return { cliSessionId: cliId, shared }
}

/** Trash a CLI transcript no pi session points at any more. */
async function trashOrphanedLedger(
  map: Record<string, string>,
  cwd: string | undefined,
  cliId: string,
): Promise<void> {
  // A clone shares nothing with its parent's ledger (the fork above copies
  // it), so a second referrer means our own bookkeeping is wrong — leave the
  // file alone rather than delete a transcript something is still resuming.
  if (!cwd || Object.values(map).includes(cliId)) return
  const ledger = claudeSessionFileForCwd(cwd, cliId)
  // Absent is the normal case for a session that never finished a CLI turn.
  await access(ledger)
  await shell.trashItem(ledger)
}
