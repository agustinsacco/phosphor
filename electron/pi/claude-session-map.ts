/**
 * pi session id → Claude Code CLI session id.
 *
 * The two ids used to be one: pi passed its own session id straight through
 * to `claude --session-id`, so a pi session and its CLI transcript shared a
 * name and the path could be derived from the pi id alone. Observer mode
 * (`@saccolabs/pi-claude-cli` ≥ 0.4.x) broke that. The provider now owns ONE
 * long-lived CLI session per pi session, resumed across turns and restarts,
 * and records the pairing in a sidecar map of its own — alongside, per CLI
 * session, the system prompt it was created with, which the provider replays
 * verbatim on every resume to keep the cached prefix valid.
 *
 * Everything derived from the old assumption pointed at a file that does not
 * exist: the debug block a user pastes into a bug report, and the second half
 * of a session delete — which is how multi-megabyte CLI transcripts were left
 * behind for every session ever deleted.
 *
 * The sidecar is the provider's, not ours. Nothing here writes to it, every
 * read is best-effort, and a miss falls back to the pi id, which is still
 * correct for sessions recorded before observer mode. `claude-ledger.ts` is
 * the one module that writes, and it re-reads through here immediately before
 * each write — a parked CLI process can touch the map at any moment.
 */

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Mirrors `stateDir()` in the provider's `src/session-map.ts`. */
export function providerStateDir(): string {
  return process.env.PI_CLAUDE_CLI_STATE_DIR ?? join(homedir(), '.pi', 'agent', 'pi-claude-cli')
}

/** Mirrors `mapPath()` in the provider: same directory, same file name. */
export function sessionMapPath(): string {
  return join(providerStateDir(), 'session-map.json')
}

/**
 * Where the provider stores the system prompt a CLI session was created with.
 * Its first bytes carry the context policy that session was written under, so
 * the provider refuses to resume it under a different one.
 */
export function storedPromptPath(cliSessionId: string): string {
  return join(providerStateDir(), 'sysprompt', `${cliSessionId}.txt`)
}

/** The whole sidecar map. Missing, unreadable or corrupt all mean "empty". */
export async function readSessionMap(): Promise<Record<string, string>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(sessionMapPath(), 'utf-8'))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, string>
    }
  } catch {
    // Same stance as the provider's own reader.
  }
  return {}
}

/**
 * The CLI session id paired with a pi session, or null when the map has no
 * entry for it (never ran on the provider, ran before observer mode, the
 * pairing was reset, or the sidecar is missing).
 */
export async function claudeSessionIdFor(piSessionId: string): Promise<string | null> {
  const mapped = (await readSessionMap())[piSessionId]
  return typeof mapped === 'string' && mapped.length > 0 ? mapped : null
}
