import type { TerminalSubscribe, TerminalFrame } from '@phosphor/shared/host-protocol-terminals'
import { FORCED_EXIT_CODE, type TerminalState } from './service-state'

export function subscribe(
  state: TerminalState,
  reap: () => void,
  frame: TerminalSubscribe,
  send: (frame: TerminalFrame) => void,
  clientId?: string,
  configuration: () => boolean = () => false,
): (() => void) | null {
  const { entries, options } = state
  if (state.closed) return null
  reap()
  const entry = entries.get(frame.terminalId)
  if (
    !entry ||
    (entry.login?.configuration && (!configuration() || entry.login.authorized?.() === false)) ||
    (entry.login && entry.login.owner !== clientId)
  )
    return null
  if (entry.login && entry.status === 'running') entry.login.disconnectedAt = undefined
  const deliver = (f: TerminalFrame) => {
    if (!entry.login?.configuration || (configuration() && entry.login.authorized?.() !== false))
      send({ ...f, ...('id' in f ? { id: frame.id } : {}) })
  }
  entry.listeners.add(deliver)
  const after = frame.after
  if (
    after &&
    after.epoch === options.epoch &&
    after.seq <= entry.seq &&
    after.seq >= (entry.chunks[0]?.seq ?? entry.seq + 1) - 1 &&
    entry.status === 'running'
  ) {
    for (const chunk of entry.chunks)
      if (chunk.seq > after.seq)
        deliver({
          type: 'terminal.output',
          id: frame.id,
          terminalId: entry.terminalId,
          epoch: options.epoch,
          seq: chunk.seq,
          data: chunk.data,
        })
  } else
    deliver({
      type: 'terminal.reset',
      id: frame.id,
      terminalId: entry.terminalId,
      epoch: options.epoch,
      seq: entry.seq,
      data: entry.chunks.map((c) => c.data).join(''),
      inputSeq: entry.inputSeq,
      status: entry.status,
    })
  if (entry.login && entry.status !== 'running') {
    deliver({
      type: 'terminal.exit',
      id: frame.id,
      terminalId: entry.terminalId,
      epoch: options.epoch,
      seq: ++entry.seq,
      exitCode: entry.exitCode ?? FORCED_EXIT_CODE,
    })
    entries.delete(entry.terminalId)
    entry.listeners.clear()
  }
  return () => entry.listeners.delete(deliver)
}
