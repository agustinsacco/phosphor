import { createReadStream, createWriteStream, realpathSync } from 'node:fs'
import { open, rename, unlink } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { pipeline } from 'node:stream/promises'

/**
 * Keep a session file's recorded cwd pointing at the folder it actually lives
 * under.
 *
 * pi writes the cwd it ran in into the session header and FREEZES it there;
 * nothing rewrites history when the folder later moves. Renaming a sandbox
 * moves the folder and both transcript directories, so the sessions are still
 * listed — but every file inside still names the old folder, and on resume pi
 * reads that header rather than the `--cwd` it was spawned with. It prints
 * `Stored session working directory does not exist: …` and exits 1 before the
 * session starts. Every chat in a renamed sandbox became permanently
 * unopenable, with nothing in the UI to say why.
 *
 * The directory is the authority, the same reasoning as in
 * `session-scanner.ts`: a session directory's name is a pure function of the
 * cwd, so a file found under this workspace's directory belongs to this
 * workspace whatever its header claims. Realigning the header to the folder it
 * was found under is a correction, not a guess — and it repairs sessions an
 * earlier rename already broke, not just the next one.
 *
 * Only safe while no pi process owns the file (the same rule as
 * `session-writer.ts`), which is why this runs immediately before the spawn
 * that resumes it.
 */

/**
 * How much of the file's start to read looking for the header.
 *
 * It is line 1 in every file pi writes. A legacy file whose first line is
 * longer than this, or that has no header at all, is left exactly as pi wrote
 * it: pi has its own fallback for those, and guessing is worse than the
 * behaviour we already have.
 */
const HEADER_WINDOW_BYTES = 64 * 1024

interface Header {
  record: Record<string, unknown>
  /** Byte offset of the first body line, i.e. just past the header's LF. */
  bodyOffset: number
}

/**
 * Point `path`'s header at `cwd`, unless it already resolves there.
 *
 * `cwd` must be the REAL path (symlinks resolved), because that is what pi
 * itself records and what the comparison below is against. Returns whether the
 * file was rewritten, for logging and tests.
 */
export async function realignSessionCwd(path: string, cwd: string): Promise<boolean> {
  const header = await readHeader(path)
  if (!header) return false
  const recorded = header.record.cwd
  if (typeof recorded !== 'string' || recorded === cwd) return false
  // A second spelling of this same folder (any symlink on the way to it)
  // resumes fine, so it is not worth rewriting a multi-megabyte file over.
  // A header naming a folder that is GONE, or a different folder that now
  // holds the old name — sandbox numbers get reused — is.
  if (resolvesTo(recorded, cwd)) return false
  await rewriteHeader(path, { ...header.record, cwd }, header.bodyOffset)
  return true
}

async function readHeader(path: string): Promise<Header | null> {
  const handle = await open(path, 'r').catch(() => null)
  if (!handle) return null
  try {
    const buffer = Buffer.allocUnsafe(HEADER_WINDOW_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, HEADER_WINDOW_BYTES, 0)
    // Searched as BYTES, not characters: a header carries arbitrary text and
    // slicing a UTF-8 buffer at a character index would cut it mid-sequence.
    const newline = buffer.subarray(0, bytesRead).indexOf(0x0a)
    if (newline === -1) return null
    const record = JSON.parse(buffer.subarray(0, newline).toString('utf8')) as Record<
      string,
      unknown
    >
    if (record.type !== 'session') return null
    return { record, bodyOffset: newline + 1 }
  } catch {
    return null
  } finally {
    await handle.close()
  }
}

/**
 * True when `recorded` is another name for `cwd`; false when it is gone or is
 * a different folder.
 *
 * Sync, and `.native`, to match every other real-path resolution here
 * (`pi-paths.ts`, `store.ts`) — the promise form has no `.native`, and the two
 * disagree about case on macOS, which would make a healthy header look stale.
 */
function resolvesTo(recorded: string, cwd: string): boolean {
  try {
    return realpathSync.native(recorded) === cwd
  } catch {
    return false
  }
}

/**
 * Replace line 1 and keep the rest byte for byte.
 *
 * Streamed through a sibling temp file rather than read-modify-write: the
 * largest real session here is 3.5 MB and this runs on the open path of every
 * resume that needs it. The rename is atomic on the same filesystem, so a
 * crash mid-write leaves the original transcript intact.
 */
async function rewriteHeader(
  path: string,
  record: Record<string, unknown>,
  bodyOffset: number,
): Promise<void> {
  const temp = `${path}.${randomBytes(4).toString('hex')}.tmp`
  try {
    const out = createWriteStream(temp)
    await new Promise<void>((resolve, reject) => {
      out.write(JSON.stringify(record) + '\n', (error) => (error ? reject(error) : resolve()))
    })
    await pipeline(createReadStream(path, { start: bodyOffset }), out)
    await rename(temp, path)
  } catch (error) {
    await unlink(temp).catch(() => undefined)
    throw error
  }
}
