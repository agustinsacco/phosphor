import { createReadStream } from 'node:fs'
import { open } from 'node:fs/promises'
import type { SessionMeta } from '@shared/models'
import { extractText } from './session-content'

/**
 * The fold behind session metadata, split out so it can be run twice: once
 * over a whole file, and once over only the bytes appended since last time.
 *
 * pi appends to a session file at the end of every turn, so a cache keyed on
 * (mtime, size) misses on every turn and re-reads the file from byte 0. That
 * is O(file) per turn and therefore O(n²) over a session's life. MEASURED
 * across 112 real session files: 25 MB on disk cost 815 MB of re-parsing, with
 * one 1.33 MB session re-read 132 times over.
 *
 * Session files are append-only, which is what makes the incremental path
 * available at all. `resumeFold` still verifies that before trusting it.
 */

interface HeaderFields {
  id?: string
  cwd?: string
  timestamp?: string
  parentSession?: string
}

/** Everything the fold carries between lines. Mutated in place. */
export interface FoldState {
  header: HeaderFields | null
  name?: string
  /**
   * Id of the first non-header entry. Together with `parentSession` it tells a
   * BRANCH (pi's `fork`, which copies the parent's entries and so repeats its
   * first id) apart from a plain successor session (`/new`, which also records
   * a `parentSession` but shares no entries). See `dropSupersededSessions`.
   */
  firstEntryId?: string
  firstUserText?: string
  userMessages: number
  assistantMessages: number
  toolCalls: number
  totalTokens: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  cost: number
  /** Summed from the `details.headroom` receipts the bundled extension writes. */
  headroomSavedTokens: number
  entryCount: number
  lastTimestamp?: string
  branchCount: number
  /**
   * Parent ids seen so far. The only unbounded member — a second entry naming
   * an already-seen parent is what a branch IS, so the whole history has to
   * stay reachable. It is why resumable state is capped to a few sessions.
   */
  seenParents: Set<string>
}

export function emptyFold(): FoldState {
  return {
    header: null,
    userMessages: 0,
    assistantMessages: 0,
    toolCalls: 0,
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cost: 0,
    headroomSavedTokens: 0,
    entryCount: 0,
    branchCount: 0,
    seenParents: new Set(),
  }
}

/** Deep enough copy to survive a failed incremental fold. */
export function cloneFold(state: FoldState): FoldState {
  return { ...state, seenParents: new Set(state.seenParents) }
}

/**
 * Fold one JSONL line into `state`.
 *
 * Lifted verbatim from the original single-pass parser; an unparseable line is
 * skipped rather than failing the file, because a session being written to can
 * legitimately end mid-record.
 */
export function foldLine(state: FoldState, line: string): void {
  if (!line.trim()) return
  let entry: Record<string, unknown>
  try {
    entry = JSON.parse(line) as Record<string, unknown>
  } catch {
    return
  }

  const type = entry.type as string
  if (type === 'session') {
    state.header = entry as unknown as HeaderFields
    return
  }
  state.entryCount++
  if (!state.firstEntryId && typeof entry.id === 'string') state.firstEntryId = entry.id
  if (typeof entry.timestamp === 'string') state.lastTimestamp = entry.timestamp
  const parentId = entry.parentId as string | null
  if (parentId) {
    if (state.seenParents.has(parentId)) state.branchCount++
    state.seenParents.add(parentId)
  }

  if (type === 'session_info') {
    state.name = (entry.name as string | undefined) || undefined
    return
  }
  if (type !== 'message') return

  const message = entry.message as
    | {
        role?: string
        content?: unknown
        details?: { headroom?: { savedTokens?: unknown } }
        usage?: {
          totalTokens?: number
          input?: number
          output?: number
          cacheRead?: number
          cacheWrite?: number
          cost?: { total?: number }
        }
      }
    | undefined
  if (!message) return

  if (message.role === 'user') {
    state.userMessages++
    if (!state.firstUserText) state.firstUserText = extractText(message.content)
    return
  }
  if (message.role === 'toolResult') {
    // Receipt written by pi-ext/headroom.ts when it compressed this result.
    const saved = message.details?.headroom?.savedTokens
    if (typeof saved === 'number' && saved > 0) state.headroomSavedTokens += saved
    return
  }
  if (message.role !== 'assistant') return

  state.assistantMessages++
  const content = message.content
  if (Array.isArray(content)) {
    state.toolCalls += content.filter((b) => (b as { type?: string }).type === 'toolCall').length
  }
  const usage = message.usage
  if (!usage) return
  state.totalTokens +=
    usage.totalTokens ??
    (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0)
  state.inputTokens += usage.input ?? 0
  state.outputTokens += usage.output ?? 0
  state.cacheReadTokens += usage.cacheRead ?? 0
  state.cacheWriteTokens += usage.cacheWrite ?? 0
  state.cost += usage.cost?.total ?? 0
}

/** Build the public meta, or null for a file with no usable header. */
export function metaFromFold(state: FoldState, path: string, mtimeMs: number): SessionMeta | null {
  const header = state.header
  if (!header?.id) return null
  return {
    path,
    sessionId: header.id,
    cwd: header.cwd ?? '',
    createdAt: header.timestamp ?? '',
    parentSession: header.parentSession,
    firstEntryId: state.firstEntryId,
    name: state.name,
    firstUserText: state.firstUserText?.slice(0, 200),
    userMessages: state.userMessages,
    assistantMessages: state.assistantMessages,
    toolCalls: state.toolCalls,
    totalTokens: state.totalTokens,
    inputTokens: state.inputTokens,
    outputTokens: state.outputTokens,
    cacheReadTokens: state.cacheReadTokens,
    cacheWriteTokens: state.cacheWriteTokens,
    cost: state.cost,
    headroomSavedTokens: state.headroomSavedTokens,
    entryCount: state.entryCount,
    branchCount: state.branchCount,
    mtimeMs,
    lastActivityAt: state.lastTimestamp ?? header.timestamp ?? '',
  }
}

const LF = 0x0a
const CR = 0x0d

/**
 * Fold every COMPLETE line from `start`, returning the byte offset just past
 * the last one.
 *
 * Framed on raw bytes rather than decoded text on purpose. The returned offset
 * has to be exact — it is where the next incremental read begins — and a
 * string-level split cannot give that, because the byte length of a decoded
 * line is not recoverable once a multi-byte sequence has been split across
 * chunks. Scanning bytes for LF is safe for the same reason readline is not:
 * no continuation byte of a UTF-8 sequence can be 0x0A.
 *
 * A trailing fragment with no LF is deliberately NOT folded and NOT counted.
 * It is a half-written record; the next pass picks it up whole.
 */
export async function foldFrom(path: string, start: number, state: FoldState): Promise<number> {
  const stream = createReadStream(path, { start })
  let pending: Buffer | null = null
  let consumed = start

  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      const buffer: Buffer = pending ? Buffer.concat([pending, chunk]) : chunk
      let from = 0
      let index: number
      while ((index = buffer.indexOf(LF, from)) !== -1) {
        let end = index
        if (end > from && buffer[end - 1] === CR) end--
        if (end > from) foldLine(state, buffer.subarray(from, end).toString('utf8'))
        consumed += index - from + 1
        from = index + 1
      }
      pending = from < buffer.length ? buffer.subarray(from) : null
    }
  } finally {
    stream.destroy()
  }

  return consumed
}

/**
 * Bytes kept from the end of the parsed region, to prove the next read is
 * really an append. 64 is far more than enough to catch a rewrite: any change
 * to the file's history moves what sits at that boundary.
 */
export const RESUME_SIGNATURE_BYTES = 64

/** Read the signature bytes ending at `offset`. Null if it cannot be read. */
export async function readSignature(path: string, offset: number): Promise<string | null> {
  const length = Math.min(RESUME_SIGNATURE_BYTES, offset)
  if (length <= 0) return ''
  let handle
  try {
    handle = await open(path, 'r')
    const buffer = Buffer.allocUnsafe(length)
    const { bytesRead } = await handle.read(buffer, 0, length, offset - length)
    if (bytesRead !== length) return null
    return buffer.toString('base64')
  } catch {
    return null
  } finally {
    await handle?.close()
  }
}
