import type { FileHandle } from 'node:fs/promises'
import { StringDecoder } from 'node:string_decoder'
import {
  BRAIN_OWNER_CUSTOM_TYPE,
  brainOwnerFromEntry,
} from '@phosphor/session-runtime/pi/brain-session-owner'

type Frame = {
  kind: '{' | '['
  state: 'keyOrEnd' | 'key' | 'colon' | 'value' | 'valueOrEnd' | 'commaOrEnd'
  path: 'root' | 'data' | 'ignore'
  key?: string
  critical: Set<string>
}
function invalid(): never {
  throw new Error('Brain transcript ownership malformed')
}

/** Deletion checks JSON structure and every top-level owner without retaining message payloads. */
class OwnerRecords {
  private stack: Frame[] = []
  private record: Record<string, unknown> = {}
  private ended = false
  private owners = 0
  constructor(private readonly jobId: string) {}
  wantsString(): boolean {
    return this.stack.at(-1)?.path !== 'ignore'
  }
  string(value: string | undefined): void {
    const frame = this.stack.at(-1)
    if (frame?.kind === '{' && ['key', 'keyOrEnd'].includes(frame.state)) {
      const critical =
        frame.path === 'root'
          ? ['type', 'customType', 'data']
          : frame.path === 'data'
            ? ['kind', 'jobId']
            : []
      if (value && critical.includes(value)) {
        if (frame.critical.has(value)) invalid()
        frame.critical.add(value)
      }
      frame.key = value
      frame.state = 'colon'
    } else this.value(value)
  }
  value(value: unknown): void {
    const frame = this.stack.at(-1)
    if (!frame || !['value', 'valueOrEnd'].includes(frame.state)) invalid()
    if (frame.path === 'root' && ['type', 'customType', 'data'].includes(frame.key ?? ''))
      this.record[frame.key!] = value
    if (frame.path === 'data' && ['kind', 'jobId'].includes(frame.key ?? ''))
      (this.record.data as Record<string, unknown>)[frame.key!] = value
    frame.state = 'commaOrEnd'
  }
  punctuation(char: string): void {
    const frame = this.stack.at(-1)
    if (char === '{' || char === '[') {
      // Processor records are shallow; bound structural state while streaming unlimited text.
      if (this.stack.length >= 128) invalid()
      let path: Frame['path'] = 'ignore'
      if (!frame) {
        if (this.ended || char !== '{') invalid()
        path = 'root'
      } else {
        if (frame.path === 'root' && frame.key === 'data' && char === '{') path = 'data'
        this.value(char === '{' ? {} : [])
      }
      this.stack.push({
        kind: char,
        state: char === '{' ? 'keyOrEnd' : 'valueOrEnd',
        path,
        critical: new Set(),
      })
    } else if (char === '}' || char === ']') {
      if (
        !frame ||
        frame.kind !== (char === '}' ? '{' : '[') ||
        !['keyOrEnd', 'valueOrEnd', 'commaOrEnd'].includes(frame.state)
      )
        invalid()
      this.stack.pop()
      if (!this.stack.length) {
        if (this.record.customType === BRAIN_OWNER_CUSTOM_TYPE) {
          if (brainOwnerFromEntry(this.record)?.jobId !== this.jobId)
            throw new Error('Brain transcript ownership mismatch')
          this.owners++
        }
        this.ended = true
      }
    } else if (char === ':') {
      if (frame?.kind !== '{' || frame.state !== 'colon') invalid()
      frame.state = 'value'
    } else {
      if (!frame || frame.state !== 'commaOrEnd') invalid()
      frame.state = frame.kind === '{' ? 'key' : 'value'
    }
  }
  newline(): void {
    if (this.stack.length) invalid()
    this.record = {}
    this.ended = false
  }
  finish(): void {
    this.newline()
    if (!this.owners) throw new Error('Brain transcript ownership mismatch')
  }
}

/** Strict LF JSONL lexer; irrelevant strings and arbitrarily long numbers use constant memory. */
class OwnerLexer {
  private mode: 'space' | 'string' | 'number' | 'literal' = 'space'
  private raw: string | undefined
  private escape = false
  private unicode = 0
  private number = ''
  private literal = ''
  private literalAt = 0
  private literalValue: unknown
  constructor(private readonly records: OwnerRecords) {}
  push(text: string): void {
    for (const char of text) {
      if (this.mode === 'string') {
        this.string(char)
        continue
      }
      if (this.mode === 'number') {
        if (this.digit(char)) continue
        this.endNumber()
      }
      if (this.mode === 'literal') {
        if (this.literalAt < this.literal.length) {
          if (char !== this.literal[this.literalAt++]) invalid()
          continue
        }
        this.records.value(this.literalValue)
        this.mode = 'space'
      }
      this.space(char)
    }
  }
  private space(char: string): void {
    if (char === '\n') this.records.newline()
    else if (char === ' ' || char === '\t' || char === '\r') return
    else if ('{}[]:,'.includes(char)) this.records.punctuation(char)
    else if (char === '"') {
      this.mode = 'string'
      this.raw = this.records.wantsString() ? '"' : undefined
    } else if (char === '-' || /[0-9]/.test(char)) {
      this.mode = 'number'
      this.number = char === '-' ? 'minus' : char === '0' ? 'zero' : 'int'
    } else if ('tfn'.includes(char)) {
      this.mode = 'literal'
      this.literal = char === 't' ? 'true' : char === 'f' ? 'false' : 'null'
      this.literalAt = 1
      this.literalValue = char === 't' ? true : char === 'f' ? false : null
    } else invalid()
  }
  private string(char: string): void {
    if (char.charCodeAt(0) < 32) invalid()
    if (this.raw !== undefined) {
      this.raw += char
      if (this.raw.length > 8192) this.raw = undefined
    }
    if (this.unicode) {
      if (!/[0-9a-f]/i.test(char)) invalid()
      this.unicode--
      return
    }
    if (this.escape) {
      this.escape = false
      if (char === 'u') this.unicode = 4
      else if (!'"\\/bfnrt'.includes(char)) invalid()
    } else if (char === '\\') this.escape = true
    else if (char === '"') {
      this.records.string(this.raw === undefined ? undefined : (JSON.parse(this.raw) as string))
      this.raw = undefined
      this.mode = 'space'
    }
  }
  private digit(char: string): boolean {
    const digit = /[0-9]/.test(char)
    switch (this.number) {
      case 'minus':
        if (!digit) invalid()
        this.number = char === '0' ? 'zero' : 'int'
        return true
      case 'zero':
        if (digit) invalid()
        break
      case 'int':
        if (digit) return true
        break
      case 'dot':
        if (!digit) invalid()
        this.number = 'frac'
        return true
      case 'frac':
        if (digit) return true
        break
      case 'e':
        if (char === '+' || char === '-') {
          this.number = 'esign'
          return true
        }
        if (!digit) invalid()
        this.number = 'exp'
        return true
      case 'esign':
        if (!digit) invalid()
        this.number = 'exp'
        return true
      case 'exp':
        if (digit) return true
        break
    }
    if (char === '.' && ['zero', 'int'].includes(this.number)) {
      this.number = 'dot'
      return true
    }
    if ((char === 'e' || char === 'E') && ['zero', 'int', 'frac'].includes(this.number)) {
      this.number = 'e'
      return true
    }
    return false
  }
  private endNumber(): void {
    if (!['zero', 'int', 'frac', 'exp'].includes(this.number)) invalid()
    this.records.value(0)
    this.mode = 'space'
  }
  finish(): void {
    if (this.mode === 'number') this.endNumber()
    if (this.mode === 'literal' && this.literalAt === this.literal.length) {
      this.records.value(this.literalValue)
      this.mode = 'space'
    }
    if (this.mode !== 'space') invalid()
    this.records.finish()
  }
}

export async function assertPurgeOwnership(file: FileHandle, jobId: string): Promise<void> {
  const lexer = new OwnerLexer(new OwnerRecords(jobId))
  const decoder = new StringDecoder('utf8')
  for await (const chunk of file.createReadStream({ autoClose: false, highWaterMark: 64 * 1024 }))
    lexer.push(decoder.write(chunk as Buffer))
  lexer.push(decoder.end())
  lexer.finish()
}
