/**
 * The model a lane's pi resumes with, read from the end of its session file.
 * Transcripts reach hundreds of megabytes, so this reads backward from the end
 * in chunks and stops at `tailBytes`: memory and time stay bounded and a model
 * further back than that is not found. It walks the leaf's branch as pi's
 * resume does (`resumeProvider`): the nearest `model_change`, or the nearest
 * assistant message's provider and model, decides.
 */
import { closeSync, readSync } from 'node:fs'
import { text } from '../validation-primitives'
import { openTranscriptFile, verifyTranscriptFile } from './read'

export const RECORDED_MODEL_TAIL_BYTES = 4 * 1024 * 1024
const CHUNK_BYTES = 256 * 1024
const LF = 10

export interface RecordedModel {
  readonly provider: string
  readonly id: string
}
/** `bytes`: how much of the file was read, for a caller's overall budget. Never throws. */
export type RecordedModelRead =
  | { kind: 'model'; model: RecordedModel; bytes: number }
  | { kind: 'none'; bytes: number }
  | { kind: 'unreadable'; bytes: number }

type Entry = Record<string, unknown>
const isEntry = (value: unknown): value is Entry =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** What the lane store would hold: its own validators (`lanes.provider`, `lanes.model`). */
function storable(provider: unknown, id: unknown): RecordedModel | null {
  if (typeof provider !== 'string' || typeof id !== 'string') return null
  try {
    text(provider, 64)
    text(id, 128)
  } catch {
    return null
  }
  return { provider, id }
}

/** A model entry decides even when unusable, as pi's resume stops at it. */
function modelOf(entry: Entry): RecordedModel | null | undefined {
  if (entry.type === 'model_change') return storable(entry.provider, entry.modelId)
  const message = entry.message
  if (entry.type === 'message' && isEntry(message) && message.role === 'assistant')
    return storable(message.provider, message.model)
  return undefined
}

/** Follows parent ids from the leaf, the file's last entry. */
class BranchWalk {
  private expected: unknown = undefined
  done = false
  result: RecordedModel | null = null

  visit(line: Buffer): void {
    let entry: unknown
    try {
      entry = JSON.parse(line.toString('utf8'))
    } catch {
      return // A torn or foreign line, as pi's loader skips it.
    }
    if (!isEntry(entry)) return
    if (entry.type === 'session') {
      this.done = true
      return
    }
    // A v1 file has no ids: its entries form one line, which this walks as is.
    if (this.expected !== undefined && 'id' in entry && entry.id !== this.expected) return
    const model = modelOf(entry)
    if (model !== undefined) {
      this.result = model
      this.done = true
      return
    }
    if ('id' in entry) this.expected = entry.parentId
    if (this.expected === null) this.done = true
  }
}

/** Fills `tail[from, to)` from the file; false when the file ended first. */
function fill(fd: number, tail: Buffer, from: number, to: number, offset: number): boolean {
  let at = from
  while (at < to) {
    const count = readSync(fd, tail, at, to - at, offset + at)
    if (!count) return false
    at += count
  }
  return true
}

/**
 * One buffer holds the whole tail, filled backward a chunk at a time, so a
 * line that spans chunks is never copied; each chunk is searched for line
 * ends once.
 */
function scanTail(fd: number, size: number, tailBytes: number): RecordedModelRead {
  const walk = new BranchWalk()
  const floor = Math.max(0, size - tailBytes)
  const tail = Buffer.allocUnsafe(size - floor)
  let filled = tail.length
  let lineEnd = tail.length
  while (filled > 0 && !walk.done) {
    const from = Math.max(0, filled - CHUNK_BYTES)
    if (!fill(fd, tail, from, filled, floor)) break
    // `[filled, lineEnd)` was searched already and holds no line end.
    let searchEnd = filled
    filled = from
    while (!walk.done) {
      const lf = tail.subarray(from, searchEnd).lastIndexOf(LF)
      if (lf < 0) break
      walk.visit(tail.subarray(from + lf + 1, lineEnd))
      lineEnd = searchEnd = from + lf
    }
  }
  // The file's first line is whole only when the scan reached the start.
  if (!walk.done && floor === 0 && filled === 0 && lineEnd > 0)
    walk.visit(tail.subarray(0, lineEnd))
  const bytes = tail.length - filled
  return walk.result ? { kind: 'model', model: walk.result, bytes } : { kind: 'none', bytes }
}

export function readRecordedModel(
  sessionFile: string,
  sessionsRoot: string,
  tailBytes = RECORDED_MODEL_TAIL_BYTES,
): RecordedModelRead {
  let fd: number
  try {
    fd = openTranscriptFile(sessionFile)
  } catch {
    return { kind: 'unreadable', bytes: 0 }
  }
  try {
    const stat = verifyTranscriptFile(fd, sessionFile, sessionsRoot)
    if (typeof stat === 'string') return { kind: 'unreadable', bytes: 0 }
    return scanTail(fd, stat.size, tailBytes)
  } catch {
    return { kind: 'unreadable', bytes: 0 }
  } finally {
    try {
      closeSync(fd)
    } catch {
      // The read is done; a failed close cannot change what it found.
    }
  }
}
