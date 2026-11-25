/**
 * A session file's LF-separated lines, newest first, read backward from its end
 * so a reader that needs only the last entries never loads the whole file.
 * Splits on LF only, never U+2028/U+2029 (see JsonlDecoder); a trailing CR stays
 * in the line, where JSON.parse reads it as whitespace.
 */
import { readSync } from 'node:fs'

const CHUNK_BYTES = 256 * 1024
const LF = 10

export interface BackwardLinesOptions {
  /** Read at most this many bytes back from the end; a line cut there is never returned. */
  readonly maxBytes: number
  /** The buffer's first size. The default holds the whole range, so it is never copied. */
  readonly bufferBytes?: number
  /** Refuse a line longer than this instead of growing the buffer for it. */
  readonly lineBytes?: number
}

/**
 * Why `next()` returned null. `start`: every line down to the file's first was
 * returned. `cap`: `maxBytes` was reached first. `short`: the file ended early,
 * so it shrank. `line-limit`: a line was longer than `lineBytes`.
 */
export type BackwardLinesEnd = 'start' | 'cap' | 'short' | 'line-limit'

/**
 * The buffer maps file offset `base + i` to `buffer[i]` and fills downward a
 * chunk at a time; each chunk is searched for line ends once. A line spanning
 * chunks is never copied while it fits. When the buffer is full the unfinished
 * line moves to its end, into a buffer twice as large once that line passes
 * half of it, so copying stays linear in the bytes read.
 */
export class BackwardLines {
  /** Bytes read from the file so far, for a caller's budget. */
  bytes = 0
  end: BackwardLinesEnd | null = null
  private buffer: Buffer
  private base: number
  private readonly floor: number
  private filled: number
  private searchEnd: number
  private lineEnd: number

  constructor(
    private readonly fd: number,
    size: number,
    private readonly options: BackwardLinesOptions,
  ) {
    this.floor = Math.max(0, size - options.maxBytes)
    const capacity = Math.min(size - this.floor, options.bufferBytes ?? Infinity)
    this.buffer = Buffer.allocUnsafe(capacity)
    this.base = size - capacity
    this.filled = this.searchEnd = this.lineEnd = capacity
  }

  /** The next older line, valid only until the next call; null once `end` is set. */
  next(): Buffer | null {
    while (this.end === null) {
      const lf = this.buffer.subarray(this.filled, this.searchEnd).lastIndexOf(LF)
      if (lf >= 0) {
        const at = this.filled + lf
        const line = this.buffer.subarray(at + 1, this.lineEnd)
        this.lineEnd = this.searchEnd = at
        return line
      }
      this.searchEnd = this.filled
      const pending = this.lineEnd - this.filled
      if (this.options.lineBytes !== undefined && pending > this.options.lineBytes)
        this.end = 'line-limit'
      else if (this.base + this.filled > this.floor) this.readChunk()
      else if (this.floor > 0) this.end = 'cap'
      else {
        // The file's first line is whole only because the scan reached the start.
        this.end = 'start'
        if (pending > 0) return this.buffer.subarray(this.filled, this.lineEnd)
      }
    }
    return null
  }

  private readChunk(): void {
    if (this.filled === 0) this.makeRoom()
    const from = Math.max(0, this.filled - CHUNK_BYTES, this.floor - this.base)
    for (let at = from; at < this.filled;) {
      const count = readSync(this.fd, this.buffer, at, this.filled - at, this.base + at)
      if (!count) {
        this.end = 'short'
        return
      }
      at += count
    }
    this.bytes += this.filled - from
    this.filled = from
  }

  private makeRoom(): void {
    const pending = this.lineEnd
    let target = this.buffer
    if (pending > this.buffer.length / 2 || this.buffer.length < CHUNK_BYTES) {
      const limit = (this.options.lineBytes ?? Infinity) + CHUNK_BYTES
      target = Buffer.allocUnsafe(Math.max(Math.min(this.buffer.length * 2, limit), CHUNK_BYTES))
    }
    this.buffer.copy(target, target.length - pending, 0, pending)
    this.base += pending - target.length
    this.buffer = target
    this.filled = this.searchEnd = target.length - pending
    this.lineEnd = target.length
  }
}
