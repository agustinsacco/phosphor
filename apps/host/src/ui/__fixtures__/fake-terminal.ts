import { PassThrough } from 'node:stream'
import { vi } from 'vitest'
import type { RichTerminal } from '../spinner'

/** Escape codes, spinner frames and erased lines gone: the screen as it reads once drawn. */
export function settledText(raw: string): string {
  const lines: string[] = []
  let line = ''
  // eslint-disable-next-line no-control-regex
  for (const part of raw.replace(/\x1b\[\?25[hl]/g, '').split(/(\r|\n|\x1b\[[0-9;]*[A-Za-z])/)) {
    if (part === '\n') {
      lines.push(line)
      line = ''
    } else if (part === '\r' || part === '\x1b[2K') line = ''
    else if (part === '\x1b[1A') line = lines.pop() ?? ''
    else if (!part.startsWith('\x1b[')) line += part
  }
  lines.push(line)
  return lines.map((text) => text.trimEnd()).join('\n')
}

/** A terminal without colour or animation, which records what it was sent. */
export function fakeTerminal(columns = 100) {
  const output = Object.assign(new PassThrough(), { columns, isTTY: true })
  const input = Object.assign(new PassThrough(), { isTTY: false })
  let raw = ''
  output.on('data', (chunk: Buffer) => (raw += chunk.toString('utf8')))
  const interrupt = vi.fn()
  const terminal: RichTerminal = { input, output, color: false, animate: false, interrupt }
  return {
    terminal,
    input,
    interrupt,
    /** What a person reads now. */
    text: () => settledText(raw),
    raw: () => raw,
    /** Types into the terminal once a prompt is listening. */
    type: (keys: string) => setTimeout(() => input.write(keys), 20),
  }
}
