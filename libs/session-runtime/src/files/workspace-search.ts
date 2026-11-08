import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import {
  isTextPreview,
  looksBinary,
  MAX_TEXT_FILE_BYTES,
  previewKindForPath,
} from '@shared/file-kinds'
import type { SearchQuery } from '@shared/text-search'
import {
  compileSearch,
  findLineMatches,
  MAX_SEARCH_RESULTS,
  type FileSearchResult,
  type WorkspaceSearchResult,
} from '@shared/workspace-search'

/**
 * The workspace search's core: read each listed file, run the query over it,
 * locate every match by line and column. Runs inside Desktop's search worker
 * (apps/desktop/electron/fs/workspace-search-worker.ts), never on main's
 * thread — a user's regex can take as long as it likes to fail, and only a
 * worker can be stopped mid-match.
 */

/** Files read at once. Their text is then searched one by one, in list order. */
const READ_BATCH = 8

export interface SearchJob {
  root: string
  /** Workspace-relative, `/`-separated; searched in this order. */
  files: string[]
  query: SearchQuery
  include?: string
  exclude?: string
}

/** Files found in one read batch, and the running totals. */
export interface SearchBatch {
  files: FileSearchResult[]
  searchedFiles: number
  skippedFiles: number
}

type SearchSummary = Pick<
  WorkspaceSearchResult,
  'matchCount' | 'searchedFiles' | 'skippedFiles' | 'stopped' | 'error'
>

export type SearchWorkerMessage =
  | ({ type: 'batch' } & SearchBatch)
  | { type: 'done'; summary: SearchSummary }
  | { type: 'failed'; error: string }

type Candidate = { kind: 'text'; text: string } | { kind: 'skipped' } | { kind: 'gone' }

const SKIPPED: Candidate = { kind: 'skipped' }
const GONE: Candidate = { kind: 'gone' }

/**
 * Never follow a symlink (`O_NOFOLLOW`), and never block opening a FIFO
 * (`O_NONBLOCK`). Windows has neither flag, so there the link is checked with
 * lstat first.
 */
const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)
const CHECK_LINKS = constants.O_NOFOLLOW === undefined

function inside(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

/**
 * A file's text, or why there is none: `skipped` for what a search passes
 * over (binary, too large, unreadable), `gone` for what is not a file any more
 * (deleted since the listing, a symlink, a directory).
 */
async function readText(full: string): Promise<Candidate> {
  let handle
  try {
    if (CHECK_LINKS && (await lstat(full)).isSymbolicLink()) return GONE
    handle = await open(full, OPEN_FLAGS)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return code === 'EACCES' || code === 'EPERM' ? SKIPPED : GONE
  }
  try {
    const info = await handle.stat()
    if (!info.isFile()) return GONE
    if (info.size > MAX_TEXT_FILE_BYTES) return SKIPPED
    // Read no more than the size just checked, even if the file grows.
    const buffer = Buffer.allocUnsafe(info.size)
    let length = 0
    while (length < info.size) {
      const { bytesRead } = await handle.read(buffer, length, info.size - length, length)
      if (bytesRead === 0) break
      length += bytesRead
    }
    const bytes = buffer.subarray(0, length)
    if (looksBinary(bytes)) return SKIPPED
    let text = bytes.toString('utf8')
    // Monaco drops a byte-order mark from the model, so a column counted with
    // it would land one character late.
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
    // Monaco also ends a line at CRLF or a lone CR; as `\n` they end one here,
    // and a regex's `\n` matches them. Columns stay put: a CR ends its line.
    if (text.includes('\r')) text = text.replace(/\r\n?/g, '\n')
    return { kind: 'text', text }
  } catch {
    return SKIPPED
  } finally {
    await handle.close().catch(() => {})
  }
}

/**
 * Reads listed files under `root`, and nothing outside it. `O_NOFOLLOW` only
 * refuses a link as the last part of a path, and git lists what its index
 * holds whatever is on disk now — `sub/secret.txt` still, after `sub` became a
 * link out of the workspace. So each folder is resolved once and must still
 * be the root or below it.
 */
function createReader(root: string): (path: string) => Promise<Candidate> {
  const realRoot = realpath(root)
  const folders = new Map<string, Promise<string | null>>()
  const realFolder = (dir: string): Promise<string | null> => {
    let real = folders.get(dir)
    if (!real) {
      real = Promise.all([realRoot, realpath(dir)]).then(
        ([top, resolved]) => (resolved === top || inside(top, resolved) ? resolved : null),
        () => null,
      )
      folders.set(dir, real)
    }
    return real
  }
  return async (path) => {
    // Images, video, audio and PDFs are bytes, however they sniff.
    if (previewKindForPath(path) && !isTextPreview(path)) return SKIPPED
    const full = resolve(root, path)
    if (!inside(root, full)) return GONE
    const folder = await realFolder(dirname(full))
    return folder === null ? GONE : readText(join(folder, basename(full)))
  }
}

/**
 * Search `job.files` under `job.root`, handing found files to `onBatch` as
 * each read batch is searched. Reported at once rather than held: a preview
 * is a slice of its file's text and keeps all of it alive, until it is copied
 * out to main. Resolves with the totals.
 */
export async function searchFiles(
  job: SearchJob,
  onBatch: (batch: SearchBatch) => void,
): Promise<SearchSummary> {
  const none = { matchCount: 0, searchedFiles: 0, skippedFiles: 0 }
  const compiled = compileSearch(job)
  if (compiled.status === 'invalid') return { ...none, error: compiled.error }
  if (compiled.status === 'empty') return none

  const { regex } = compiled
  const read = createReader(job.root)
  const wanted = job.files.filter(compiled.wants)
  let matchCount = 0
  let searchedFiles = 0
  let skippedFiles = 0
  /** A match past the cap was found: the results are not all there is. */
  let more = false

  for (let next = 0; next < wanted.length && !more; next += READ_BATCH) {
    const chunk = wanted.slice(next, next + READ_BATCH)
    const candidates = await Promise.all(chunk.map(read))
    const found: FileSearchResult[] = []
    for (let i = 0; i < chunk.length && !more; i++) {
      const candidate = candidates[i]!
      if (candidate.kind === 'gone') continue
      if (candidate.kind === 'skipped') {
        skippedFiles++
        continue
      }
      searchedFiles++
      // One match more than fits tells a search cut short from one that
      // happened to end at the cap.
      const room = MAX_SEARCH_RESULTS - matchCount
      const matches = findLineMatches(candidate.text, regex, room + 1)
      if (matches.length > room) {
        more = true
        matches.length = room
      }
      if (matches.length === 0) continue
      found.push({ path: chunk[i]!, matches })
      matchCount += matches.length
    }
    onBatch({ files: found, searchedFiles, skippedFiles })
  }
  return { matchCount, searchedFiles, skippedFiles, ...(more ? { stopped: 'results' } : {}) }
}
