import { shell } from 'electron'
import { createReadStream } from 'node:fs'
import { access, rmdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { claudeSessionFileForCwd, piSessionsRoot } from './pi-paths'
import { forgetClaudePairing } from './claude-ledger'

/**
 * Deleting a session means deleting every ledger it wrote.
 *
 * A session on the `pi-claude-cli` provider is persisted twice: pi's own
 * transcript, and the Claude Code CLI's parallel copy under
 * ~/.claude/projects. Only the first was ever removed, so the CLI copy — much
 * the larger of the two, tens of megabytes for a long session — survived
 * every delete with nothing left pointing at it.
 *
 * Both go to the trash rather than being unlinked: a transcript is the only
 * record of a conversation, and "delete" in the sidebar should be as
 * recoverable as deleting a file in a file manager.
 *
 * Each ledger also leaves bookkeeping that nothing reads once the session is
 * gone, and all of it goes too: the CLI's `<id>/` sidecar directory (subagent
 * transcripts, oversized tool results — it outlived every delete, jsonl or
 * not), the provider's map entry and stored system prompt, and pi's session
 * directory once its last transcript has left. Hundreds of each had piled up.
 *
 * The CLI copy is strictly best-effort. Its absence is the normal case for
 * every other provider and for sessions older than the provider itself, so a
 * miss is silent and never fails the delete.
 *
 * NOTE: plain readline is fine here for the same reason it is in
 * session-scanner — a persisted, LF-terminated file, parsed defensively.
 */

const CLAUDE_CLI_PROVIDER = 'pi-claude-cli'

interface ClaudeLedgerRef {
  cwd: string
  sessionId: string
}

/**
 * Read a pi transcript for the identity of its Claude Code counterpart, or
 * null when the session never ran on that provider.
 *
 * The provider is not in the header — it arrives in `model_change` entries and
 * is repeated on every assistant message — so a session that switched
 * providers mid-run is only recognisable by scanning. We stop at the first
 * hit, which for a Claude session is the second line of the file.
 */
async function claudeLedgerRef(sessionFilePath: string): Promise<ClaudeLedgerRef | null> {
  const stream = createReadStream(sessionFilePath, { encoding: 'utf8' })
  const rl = createInterface({ input: stream, crlfDelay: Infinity })

  let cwd: string | undefined
  let sessionId: string | undefined

  try {
    for await (const line of rl) {
      if (!line.trim()) continue
      let entry: Record<string, unknown>
      try {
        entry = JSON.parse(line) as Record<string, unknown>
      } catch {
        continue
      }

      if (entry.type === 'session') {
        sessionId = entry.id as string | undefined
        cwd = entry.cwd as string | undefined
        continue
      }

      const message = entry.message as { provider?: string } | undefined
      if (entry.provider === CLAUDE_CLI_PROVIDER || message?.provider === CLAUDE_CLI_PROVIDER) {
        return cwd && sessionId ? { cwd, sessionId } : null
      }
    }
  } finally {
    rl.close()
    stream.close()
  }

  return null
}

/** Trash a path if it is there — a missing one is not an error here. */
async function trashIfPresent(path: string): Promise<void> {
  try {
    await access(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  await shell.trashItem(path)
}

/**
 * Delete one on-disk session: pi's transcript, plus the Claude Code CLI's
 * copy when the session ran on that provider and the copy still exists.
 *
 * pi's transcript is read for the CLI pointer BEFORE it is trashed — it is
 * the only thing that knows the session's id and cwd.
 */
export async function deleteSession(sessionFilePath: string): Promise<void> {
  let claudeRef: ClaudeLedgerRef | null = null
  try {
    claudeRef = await claudeLedgerRef(sessionFilePath)
  } catch {
    // An unreadable or malformed transcript still gets deleted; we just lose
    // the pointer to its counterpart.
  }

  // A pending lane may never have flushed, or an older delete already removed
  // its file while leaving another live writer. Both are successful deletes.
  await trashIfPresent(sessionFilePath)
  await removePiSessionDirIfEmpty(sessionFilePath)

  if (!claudeRef) return
  try {
    // Observer mode files the CLI transcript under the CLI's OWN session id,
    // so deleting by the pi id trashed nothing and left a transcript (often
    // megabytes) behind for every session ever deleted. The pi id remains the
    // right fallback for sessions recorded before that change.
    const { cliSessionId, shared } = await forgetClaudePairing(claudeRef.sessionId)
    // A second pi session still resuming this CLI session means our own
    // bookkeeping is wrong somewhere; leave its transcript alone.
    if (shared) return
    const ledger = claudeSessionFileForCwd(claudeRef.cwd, cliSessionId ?? claudeRef.sessionId)
    await trashIfPresent(ledger)
    await trashIfPresent(ledger.slice(0, -'.jsonl'.length))
  } catch {
    // Best-effort: the pi transcript is already gone, and failing the whole
    // delete over the second copy would be a worse outcome than an orphan.
  }
}

/**
 * Drop pi's per-cwd session directory once its last transcript is gone — one
 * empty directory per deleted lane otherwise, forever (516 of 607 on one
 * install). `rmdir` refuses a non-empty directory, which is the whole safety
 * check, and pi recreates the directory whenever it next writes there.
 *
 * Only a direct child of pi's sessions root is ever a candidate: a transcript
 * passed from anywhere else must not get its parent folder removed.
 */
async function removePiSessionDirIfEmpty(sessionFilePath: string): Promise<void> {
  const dir = dirname(resolve(sessionFilePath))
  if (dirname(dir) !== resolve(piSessionsRoot())) return
  await rmdir(dir).catch(() => undefined)
}
