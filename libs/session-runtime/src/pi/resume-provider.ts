import { constants, readSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { BackwardLines } from './backward-lines'
import {
  parseSessionLine,
  SESSION_ENTRIES_MAX,
  TRANSCRIPT_FILE_MAX_BYTES,
  type SessionEntryLike,
} from './session-context'

/** One entry may be as large as the whole file resume once read at once. */
const LINE_BYTES = 64 * 1024 * 1024
/** The ids and providers the walk keeps, in UTF-16 code units. */
const INDEX_CHARS = 32 * 1024 * 1024
/** A long walk lets the event loop run this often. */
const YIELD_BYTES = 16 * 1024 * 1024
const LF = 10
const UNVERIFIED = 'Cannot verify the resumed session provider.'
const CHANGED = 'The session changed while verifying its provider.'

/** The token `code` is what a Host logs (`lane.command_error`); the message stays fixed. */
const refusal = (code: string, message = UNVERIFIED) => Object.assign(new Error(message), { code })

/** What the walk needs of one entry, without its content. */
interface Step {
  readonly session: boolean
  readonly id: unknown
  readonly parentId: unknown
  /** Mirrors pi's getSessionContextSettings, including assistant model switches. */
  readonly decides: boolean
  readonly provider: string | undefined
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null
// A parsed object never equals another, so it keeps no content alive as a key.
const key = (value: unknown) => (typeof value === 'object' && value !== null ? Symbol() : value)
const chars = (value: unknown) => (typeof value === 'string' ? value.length : 0)

function step(entry: SessionEntryLike): Step {
  const message = entry.message
  const assistant =
    entry.type === 'message' && record(message) && 'role' in message && message.role === 'assistant'
  const source = assistant ? message : entry
  const decides = entry.type === 'model_change' || assistant
  return {
    session: entry.type === 'session',
    id: key(entry.id),
    parentId: key(entry.parentId),
    decides,
    provider: decides && typeof source.provider === 'string' ? source.provider : undefined,
  }
}

/** The file's first entry, read forward: pi's loader requires a session header there. */
function readHeader(fd: number, size: number): SessionEntryLike | null {
  const limit = Math.min(size, LINE_BYTES)
  let buffer = Buffer.allocUnsafe(Math.min(limit, 64 * 1024))
  let filled = 0
  let lineStart = 0
  for (;;) {
    const lf = buffer.subarray(0, filled).indexOf(LF, lineStart)
    if (lf >= 0 || filled === limit) {
      const entry = parseSessionLine(buffer.toString('utf8', lineStart, lf >= 0 ? lf : filled))
      if (entry !== undefined) return entry
      if (lf < 0) return null
      lineStart = lf + 1
      continue
    }
    if (filled === buffer.length) {
      const grown = Buffer.allocUnsafe(Math.min(buffer.length * 2, limit))
      buffer.copy(grown, 0, 0, filled)
      buffer = grown
    }
    const count = readSync(fd, buffer, filled, buffer.length - filled, filled)
    if (!count) throw refusal('resume-provider-changed', CHANGED)
    filled += count
  }
}

/**
 * Entries newest first, each indexed by id as it is read. A lookup reads
 * further back only until it finds the id, so the first match is the id's last
 * occurrence in the file, as in pi's index.
 */
class BranchIndex {
  private readonly index = new Map<unknown, Step>()
  private entries = 0
  private indexChars = 0
  private yielded = 0

  constructor(private readonly lines: BackwardLines) {}

  /** The next older entry; null once the scan reached the file's start. */
  older(): Step | null {
    for (let line = this.lines.next(); line; line = this.lines.next()) {
      const entry = parseSessionLine(line.toString('utf8'))
      if (entry === undefined) continue
      if (!entry) throw refusal('resume-provider-unverified')
      if (++this.entries > SESSION_ENTRIES_MAX) throw refusal('transcript-index-too-large')
      const found = step(entry)
      if (!found.session && !this.index.has(found.id)) {
        this.indexChars += chars(found.id) + chars(found.parentId) + chars(found.provider)
        if (this.indexChars > INDEX_CHARS) throw refusal('transcript-index-too-large')
        this.index.set(found.id, found)
      }
      return found
    }
    if (this.lines.end === 'line-limit') throw refusal('transcript-line-too-large')
    if (this.lines.end !== 'start') throw refusal('resume-provider-changed', CHANGED)
    return null
  }

  async find(id: unknown): Promise<Step | null> {
    while (!this.index.has(id)) {
      if (!this.older()) return null
      await this.pause()
    }
    return this.index.get(id) ?? null
  }

  async olderOutsideSession(): Promise<Step | null> {
    let found = this.older()
    while (found?.session) {
      await this.pause()
      found = this.older()
    }
    return found
  }

  private async pause(): Promise<void> {
    if (this.lines.bytes - this.yielded < YIELD_BYTES) return
    this.yielded = this.lines.bytes
    await new Promise((resolve) => setImmediate(resolve))
  }
}

/** Mirrors pi's migration (v1 files chain their entries in order) and buildSessionPath. */
async function walkBranch(fd: number, size: number): Promise<string | undefined> {
  const header = readHeader(fd, size)
  if (!header || header.type !== 'session' || typeof header.id !== 'string')
    throw refusal('resume-provider-unverified')
  const linear = Number(header.version ?? 1) < 2
  const lines = new BackwardLines(fd, size, {
    maxBytes: size,
    bufferBytes: 1024 * 1024,
    lineBytes: LINE_BYTES,
  })
  const branch = new BranchIndex(lines)
  const seen = new Set<Step>()
  let leaf = branch.older()
  while (leaf && !leaf.session) {
    if (seen.has(leaf)) throw refusal('resume-provider-unverified')
    seen.add(leaf)
    if (leaf.decides) return leaf.provider
    leaf = linear ? await branch.olderOutsideSession() : await branch.find(leaf.parentId)
  }
  return undefined
}

/**
 * pi restores the last model on the selected branch, not today's global default.
 * Reads backward from the end only as far as the branch's walk needs, so a
 * transcript of any size up to TRANSCRIPT_FILE_MAX_BYTES resolves. Never write
 * or repair the transcript, or fall back after a failed inspection.
 */
export async function resumeProvider(path: string): Promise<string | undefined> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = await file.stat()
    if (!before.isFile()) throw refusal('resume-provider-unverified')
    if (before.size > TRANSCRIPT_FILE_MAX_BYTES) throw refusal('transcript-too-large')
    const provider = await walkBranch(file.fd, before.size)
    const after = await file.stat()
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs)
      throw refusal('resume-provider-changed', CHANGED)
    return provider
  } finally {
    await file.close()
  }
}
