/**
 * The model a lane's pi resumes with, read from the end of its session file.
 * Transcripts reach hundreds of megabytes, so this reads backward from the end
 * in chunks and stops at `tailBytes`: memory and time stay bounded and a model
 * further back than that is not found. It walks the leaf's branch as pi's
 * resume does (`resumeProvider`): the nearest `model_change`, or the nearest
 * assistant message's provider and model, decides.
 */
import { closeSync, readSync } from 'node:fs'
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

/** The lane store's column bounds (`lanes.provider`, `lanes.model`). */
function storable(provider: unknown, id: unknown): RecordedModel | null {
  return typeof provider === 'string' &&
    typeof id === 'string' &&
    provider.length > 0 &&
    provider.length <= 64 &&
    id.length > 0 &&
    id.length <= 128
    ? { provider, id }
    : null
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

function scanTail(fd: number, size: number, tailBytes: number): RecordedModelRead {
  const walk = new BranchWalk()
  const floor = Math.max(0, size - tailBytes)
  let end = size
  let carry = Buffer.alloc(0)
  while (end > floor && !walk.done) {
    const start = Math.max(floor, end - CHUNK_BYTES)
    const chunk = Buffer.alloc(end - start)
    let read = 0
    while (read < chunk.length) {
      const count = readSync(fd, chunk, read, chunk.length - read, start + read)
      if (!count) break
      read += count
    }
    const buffer = Buffer.concat([chunk.subarray(0, read), carry])
    let lineEnd = buffer.length
    while (lineEnd > 0 && !walk.done) {
      const lf = buffer.lastIndexOf(LF, lineEnd - 1)
      if (lf < 0) break
      walk.visit(buffer.subarray(lf + 1, lineEnd))
      lineEnd = lf
    }
    carry = buffer.subarray(0, lineEnd)
    end = start
  }
  // The file's first line is whole only when the scan reached the start.
  if (!walk.done && end === 0 && carry.length) walk.visit(carry)
  const bytes = size - end
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
