import { appendFile, open, readFile, writeFile, type FileHandle } from 'node:fs/promises'
import { randomBytes, randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'

/**
 * Careful, format-compliant appends to session JSONL files.
 * ONLY safe while no pi process owns the file — callers must dispose any
 * live subprocess for the session first.
 */

function newEntryId(): string {
  return randomBytes(4).toString('hex')
}

/**
 * How much of the file's end to read when looking for the last entry id.
 *
 * The answer is almost always on the final line, but a single entry can be
 * large (a tool result carrying a whole file), so the window has to hold a few
 * of them rather than just one. 64 KB covers that with room to spare and
 * replaces a read of the entire transcript — 3.5 MB for the largest session
 * here — on every bookmark and branch jump.
 */
const TAIL_WINDOW_BYTES = 64 * 1024

/** Last entry id in `text`, scanning backwards. Ignores the session header. */
function leafIdIn(text: string, skipFirstLine: boolean): string | null {
  const lines = text.split('\n').filter((l) => l.trim().length > 0)
  // A window read almost certainly starts mid-line; that fragment is not
  // parseable JSON, but dropping it explicitly beats relying on the catch.
  const end = skipFirstLine ? 1 : 0
  for (let i = lines.length - 1; i >= end; i--) {
    try {
      const entry = JSON.parse(lines[i]!) as { id?: string; type?: string }
      if (entry.type !== 'session' && entry.id) return entry.id
    } catch {
      continue
    }
  }
  return null
}

/**
 * The id of the last non-header entry — the parent for anything appended next.
 *
 * Reads only the tail of the file, falling back to a full read when the window
 * turns up nothing (a session whose entries are bigger than the window, or one
 * short enough that the window was the whole file anyway).
 */
async function currentLeafId(path: string): Promise<string | null> {
  let handle: FileHandle | undefined
  try {
    handle = await open(path, 'r')
    const { size } = await handle.stat()
    if (size > TAIL_WINDOW_BYTES) {
      const buffer = Buffer.allocUnsafe(TAIL_WINDOW_BYTES)
      const { bytesRead } = await handle.read(
        buffer,
        0,
        TAIL_WINDOW_BYTES,
        size - TAIL_WINDOW_BYTES,
      )
      const found = leafIdIn(buffer.subarray(0, bytesRead).toString('utf8'), true)
      if (found) return found
    }
  } catch {
    // Fall through to the whole-file read, which reports the real error.
  } finally {
    await handle?.close()
  }
  return leafIdIn(await readFile(path, 'utf8'), false)
}

/** Append a label entry (bookmark) targeting `targetId`. */
export async function appendLabel(
  path: string,
  targetId: string,
  label: string | undefined,
): Promise<void> {
  const leafId = await currentLeafId(path)
  const entry = {
    type: 'label',
    id: newEntryId(),
    parentId: leafId,
    timestamp: new Date().toISOString(),
    targetId,
    label,
  }
  await appendFile(path, JSON.stringify(entry) + '\n', 'utf8')
}

/**
 * Move the session leaf to `targetId` by appending a branch_summary entry
 * whose parent is the target — the documented mechanism behind /tree jumps.
 * On next resume, pi continues from this new leaf.
 */
export async function appendBranchJump(path: string, targetId: string): Promise<void> {
  const leafId = await currentLeafId(path)
  if (leafId === targetId) return
  const entry = {
    type: 'branch_summary',
    id: newEntryId(),
    parentId: targetId,
    timestamp: new Date().toISOString(),
    fromId: leafId,
    summary: 'Jumped here from another branch in Phosphor (tree view).',
  }
  await appendFile(path, JSON.stringify(entry) + '\n', 'utf8')
}

/**
 * Fork a session AT a specific entry: copy the file into a new session
 * (fresh header id, parentSession = source) and move its leaf to `targetId`.
 * Returns the new session file path.
 */
export async function forkSessionAt(path: string, targetId: string): Promise<string> {
  const raw = await readFile(path, 'utf8')
  const newlineIndex = raw.indexOf('\n')
  if (newlineIndex === -1) throw new Error('Malformed session file (no header line)')
  const header = JSON.parse(raw.slice(0, newlineIndex)) as Record<string, unknown>
  if (header.type !== 'session') throw new Error('Malformed session file (bad header)')

  const now = new Date()
  const newId = randomUUID()
  const newHeader = {
    ...header,
    id: newId,
    timestamp: now.toISOString(),
    parentSession: path,
  }
  const stamp = now.toISOString().replace(/[:.]/g, '-')
  const newPath = join(dirname(path), `${stamp}_${newId}.jsonl`)
  await writeFile(newPath, JSON.stringify(newHeader) + '\n' + raw.slice(newlineIndex + 1), 'utf8')
  await appendBranchJump(newPath, targetId)
  return newPath
}
