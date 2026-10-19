import { TERMINAL_LIMITS as L, type TerminalFrame } from '@phosphor/shared/host-protocol-terminals'
import type { Entry, TerminalState } from './service-state'

export function emit(entry: Entry, frame: TerminalFrame) {
  for (const listener of [...entry.listeners]) {
    try {
      listener(frame)
    } catch {
      entry.listeners.delete(listener)
    }
  }
}
export function output(state: TerminalState, entry: Entry, data: string) {
  if (
    entry.login &&
    (state.closed ||
      entry.status !== 'running' ||
      (entry.login.configuration && entry.login.authorized?.() === false))
  )
    return
  // Split on Unicode codepoints, not UTF-16 halves or UTF-8 continuation bytes.
  let text = ''
  let bytes = 0
  function flush() {
    if (!text) return
    entry.chunks.push({ seq: ++entry.seq, data: text, bytes })
    entry.outputBytes += bytes
    while (entry.outputBytes > L.scrollbackBytes || entry.chunks.length > 2048) {
      const first = entry.chunks.shift()
      if (first) entry.outputBytes -= first.bytes
    }
    emit(entry, {
      type: 'terminal.output',
      id: 'live',
      terminalId: entry.terminalId,
      epoch: state.options.epoch,
      seq: entry.seq,
      data: text,
    })
    text = ''
    bytes = 0
  }
  for (const char of data) {
    const size = Buffer.byteLength(char)
    if (bytes + size > L.chunkBytes) flush()
    text += char
    bytes += size
  }
  flush()
}
