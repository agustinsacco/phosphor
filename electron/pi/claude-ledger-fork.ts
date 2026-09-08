import { randomUUID } from 'node:crypto'
import { copyFile, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { claudeSessionFileForCwd } from './pi-paths'

/**
 * Give a cloned pi session its own Claude Code CLI session.
 *
 * pi's `clone` RPC branches a session at the leaf onto a new file with a NEW
 * pi session id. `@saccolabs/pi-claude-cli` keys its one-CLI-session-per-pi-
 * session map on that id, so the clone's first turn misses the map, and the
 * provider reimports the entire conversation into a fresh CLI session — a
 * full-context cache write (measured: 64k tokens on a 100k-token session,
 * 2026-09-07) and a discarded cached prefix, for what the user experienced
 * as "continue where I was".
 *
 * Pointing the clone at the SAME CLI session is not an option: the original
 * survives a clone, and two pi sessions resuming one CLI session would
 * append both conversations to a single transcript and leak turns across.
 * So this does on disk what `claude --fork-session` does: copy the CLI
 * transcript under a fresh session id, carry the provider's stored system
 * prompt with it, and record the new pairing in the provider's map.
 *
 * The sidecar map belongs to the provider, and a parked CLI process can
 * write it concurrently. Every step here is therefore best-effort with a
 * safe failure mode: on any miss, race or error the map is simply left
 * without an entry for the clone, and the provider does what it does today —
 * reimport. `claude-session-map.ts` stays read-only; this module is the one
 * sanctioned writer, and only ever ADDS a key for a pi session id the
 * provider has never seen.
 *
 * Known gap: the original's `<cliSessionId>/` sidecar directory (oversized
 * tool results) is not copied. A forked transcript that references those by
 * path loses them — same trade `claude --fork-session` makes.
 */

/** Mirrors `stateDir()` in the provider's `src/session-map.ts`. */
function providerStateDir(): string {
  return process.env.PI_CLAUDE_CLI_STATE_DIR ?? join(homedir(), '.pi', 'agent', 'pi-claude-cli')
}

function sessionMapPath(): string {
  return join(providerStateDir(), 'session-map.json')
}

async function readSessionMap(): Promise<Record<string, string>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(sessionMapPath(), 'utf-8'))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, string>
    }
  } catch {
    // Missing or corrupt both mean "no mappings" — same stance as the provider.
  }
  return {}
}

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
    await copyFile(
      join(providerStateDir(), 'sysprompt', `${oldCliId}.txt`),
      join(providerStateDir(), 'sysprompt', `${newCliId}.txt`),
    )
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
    rm(join(providerStateDir(), 'sysprompt', `${newCliId}.txt`), { force: true }),
  ])
  return false
}
