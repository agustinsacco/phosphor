import { StringDecoder } from 'node:string_decoder'

/**
 * Strict JSONL splitter for the pi RPC protocol.
 *
 * Records are delimited by LF only; a trailing CR is stripped (CRLF input is
 * accepted). Unicode line separators (U+2028/U+2029) are legal inside JSON
 * strings and must NOT split records — this is why Node's readline is
 * explicitly not protocol-compliant here.
 *
 * Handles multi-byte UTF-8 sequences split across chunk boundaries via
 * StringDecoder.
 */
export class JsonlDecoder {
  private fragments: string[] = []
  private readonly decoder = new StringDecoder('utf8')

  /** Feed a chunk; returns zero or more complete lines (without delimiters). */
  push(chunk: Buffer | string): string[] {
    const text = typeof chunk === 'string' ? chunk : this.decoder.write(chunk)
    const lines: string[] = []
    let start = 0
    let newlineIndex: number
    // Search only new input. Joining/rescanning an unfinished record on every
    // push makes large tool results quadratic in the number of stdout chunks.
    while ((newlineIndex = text.indexOf('\n', start)) !== -1) {
      this.fragments.push(text.slice(start, newlineIndex))
      const line = this.takeLine()
      if (line.length > 0) lines.push(line)
      start = newlineIndex + 1
    }
    if (start < text.length) this.fragments.push(text.slice(start))
    return lines
  }

  /** Flush any remaining buffered data as a final line (stream end). */
  end(): string[] {
    const lines = this.push(this.decoder.end())
    const line = this.takeLine()
    if (line.length > 0) lines.push(line)
    return lines
  }

  private takeLine(): string {
    let line = this.fragments.join('')
    this.fragments = []
    if (line.endsWith('\r')) line = line.slice(0, -1)
    return line
  }
}
