import { existsSync } from 'node:fs'
import { readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { isWithinFolder, rebaseWithinFolder } from '@shared/paths'
import { piSessionsRoot, sessionDirNameForCwd } from './pi-paths'

/**
 * A pi session records the cwd it was started in, in its header line, and pi
 * REFUSES to resume a session whose stored cwd no longer exists: in RPC mode
 * `getMissingSessionCwdIssue` (pi's `core/session-cwd.ts`) prints
 * "Stored session working directory does not exist" and calls `process.exit(1)`
 * before the RPC loop ever starts. Only interactive mode offers the "continue
 * in current cwd" prompt, and there is no flag to answer it up front.
 *
 * Renaming a sandbox moves the folder, so every session inside it stores a cwd
 * that is now gone. The rename already moved the folder, pi's transcripts, the
 * CLI's transcripts and the stored prefs — but not this, so the sessions stayed
 * in the sidebar, looked fine, and died on click with pi exiting 1. That is the
 * bug this module exists for.
 *
 * ONLY safe while no pi process owns the file — the same convention as
 * `session-writer.ts`. Both call sites hold that: `app:renameSandbox` refuses
 * while any session under the folder is live, and `spawnSession` runs inside
 * `openSessionPath`, which has already disposed every handle on the path.
 */

/** The only fields of pi's header line this module touches. */
interface SessionHeader {
  type?: string
  cwd?: string
  parentSession?: string
}

/**
 * pi's JSONL is strictly LF-framed (see `jsonl.ts`), so the header is
 * everything before the first `\n` — byte work rather than a decode of the
 * whole transcript, which runs to megabytes.
 */
function splitHeader(text: string): { header: string; rest: string } | null {
  const end = text.indexOf('\n')
  // No newline at all: a session whose header is the entire file, written
  // before any entry landed.
  if (end === -1) return text.trim() ? { header: text, rest: '' } : null
  return { header: text.slice(0, end), rest: text.slice(end) }
}

/** The transcript directory pi derives from a cwd, unresolved. */
function transcriptDirFor(cwd: string): string {
  // Deliberately NOT `sessionDirForCwd`: that resolves symlinks, and the cwd
  // being moved away from no longer exists, so there is nothing to resolve.
  // Both sides are compared as the literal strings pi itself mangled.
  return join(piSessionsRoot(), sessionDirNameForCwd(cwd))
}

/**
 * Replace the header line, atomically.
 *
 * Temp-then-rename rather than a truncating write: the rest of the file is the
 * user's whole conversation, and a crash between truncate and write would take
 * it with it. The temp file sits in the session directory so the rename stays
 * on one filesystem.
 */
async function writeHeader(path: string, header: string, rest: string): Promise<void> {
  const temp = `${path}.${randomBytes(4).toString('hex')}.tmp`
  try {
    await writeFile(temp, header + rest)
    await rename(temp, path)
  } catch (error) {
    await unlink(temp).catch(() => undefined)
    throw error
  }
}

/**
 * Point one session at `to` if its header still says `from`.
 *
 * `parentSession` moves with it. A forked session names its parent by full
 * path, and that path contains the parent's own mangled cwd — so a rename that
 * fixed only `cwd` would leave the fork pointing into a transcript directory
 * that moved, and the branch it was forked from would read as gone.
 *
 * Returns whether anything was written, so a caller can log a repair rather
 * than guess at one.
 */
export async function repointSessionCwd(
  sessionPath: string,
  from: string,
  to: string,
): Promise<boolean> {
  if (from === to) return false

  let text: string
  try {
    text = await readFile(sessionPath, 'utf8')
  } catch {
    return false // Deleted between the listing and here.
  }

  const split = splitHeader(text)
  if (!split) return false

  let header: SessionHeader
  try {
    header = JSON.parse(split.header) as SessionHeader
  } catch {
    return false // Not a session file, or a half-written one; leave it alone.
  }
  // A file whose first line is not the header is not a shape this understands.
  if (header.type !== 'session' || header.cwd !== from) return false

  header.cwd = to
  // Prefix-anchored with a separator guard (`isWithinFolder`), so the parent of
  // a session under `--…-games--` is never rewritten by a rename of `games-2`.
  const oldParentDir = transcriptDirFor(from)
  if (header.parentSession && isWithinFolder(header.parentSession, oldParentDir)) {
    header.parentSession = rebaseWithinFolder(
      header.parentSession,
      oldParentDir,
      transcriptDirFor(to),
    )
  }

  // `JSON.stringify` of a parsed object preserves key order, so the header
  // round-trips as pi wrote it apart from the two values above.
  await writeHeader(sessionPath, JSON.stringify(header), split.rest)
  return true
}

/**
 * Repoint a session whose stored cwd has gone missing, on the way to resuming
 * it. `cwd` is where Phosphor is about to run it, already resolved.
 *
 * This is the net that catches a folder that moved WITHOUT Phosphor's rename
 * handler running — a sandbox renamed before this repair existed (which is how
 * the bug was found), one moved in Finder, or a transcript the rename's
 * best-effort pass did not reach. Narrow on purpose: it fires only when the
 * stored cwd is genuinely absent from disk and the replacement genuinely
 * exists, so a session opened while its folder is merely unmounted is left
 * intact rather than rewritten to somewhere else.
 */
export async function healMissingSessionCwd(sessionPath: string, cwd: string): Promise<boolean> {
  let header: SessionHeader
  try {
    const text = await readFile(sessionPath, 'utf8')
    const split = splitHeader(text)
    if (!split) return false
    header = JSON.parse(split.header) as SessionHeader
  } catch {
    return false
  }

  const stored = header.cwd
  if (header.type !== 'session' || !stored || stored === cwd) return false
  if (existsSync(stored) || !existsSync(cwd)) return false

  return repointSessionCwd(sessionPath, stored, cwd)
}
