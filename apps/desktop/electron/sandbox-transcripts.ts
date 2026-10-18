import { shell } from 'electron'
import { access, readdir, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { repointSessionCwd } from './pi/session-cwd'

/** True when the path is reachable — used to validate persisted locations. */
export async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/** Trash a path if it is there — a missing one is not an error here. */
export async function trashIfPresent(path: string): Promise<void> {
  if (!(await pathExists(path))) return
  await shell.trashItem(path)
}

/**
 * Move a transcript directory alongside its sandbox.
 *
 * A sandbox with no chats yet simply has no such directory, so a missing
 * source is normal. An occupied destination is left alone rather than merged:
 * it means history already exists under the new name (a sandbox that once had
 * it was deleted or renamed away), and `rename` onto a non-empty directory
 * fails anyway. The old transcripts stay where they are — orphaned, but not
 * destroyed.
 */
export async function moveIfPresent(from: string, to: string): Promise<void> {
  if (!(await pathExists(from))) return
  if (await pathExists(to)) return
  await rename(from, to)
}

/**
 * Point every transcript in `dir` at the cwd the folder now has.
 *
 * Moving the directory is not enough: pi stores the cwd INSIDE each session
 * file and refuses to resume one whose stored cwd is gone, exiting 1 before
 * the RPC loop starts (`electron/pi/session-cwd.ts`). Without this a renamed
 * sandbox kept all its chats in the sidebar and none of them would open.
 *
 * Best-effort per file, like the moves above — one unreadable transcript is
 * not a reason to fail a rename that has already happened on disk.
 */
export async function repointTranscripts(dir: string, from: string, to: string): Promise<void> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return // No chats in this cwd; the common case, not an error.
  }
  await Promise.allSettled(
    names
      .filter((name) => name.endsWith('.jsonl'))
      .map((name) => repointSessionCwd(join(dir, name), from, to)),
  )
}
