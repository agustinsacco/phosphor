import { isUuid } from './control-api'

export const TERMINAL_LIMITS = {
  perLane: 8,
  perHost: 32,
  scrollbackBytes: 256 * 1024,
  chunkBytes: 16 * 1024,
  inputBytes: 4096,
  inputBytesPerSecond: 64 * 1024,
  dimension: 1000,
} as const
export type TerminalOp =
  | { type: 'terminal.create'; cols: number; rows: number }
  | { type: 'terminal.resize'; terminalId: string; cols: number; rows: number }
  | { type: 'terminal.kill'; terminalId: string }
export interface TerminalInput {
  type: 'terminal.input'
  terminalId: string
  seq: number
  data: string
}
export interface TerminalSubscribe {
  type: 'subscribe'
  topic: 'terminal'
  id: string
  terminalId: string
  after?: { epoch: string; seq: number }
}
export interface TerminalSummary {
  terminalId: string
  /** Empty for a machine shell: one opened in the Host account's home, outside any lane. */
  laneId: string
  status: 'running' | 'exited' | 'interrupted'
}
export type TerminalFrame =
  | { type: 'terminal.ack'; terminalId: string; seq: number; accepted: boolean }
  | {
      type: 'terminal.output'
      id: string
      terminalId: string
      epoch: string
      seq: number
      data: string
    }
  | {
      type: 'terminal.reset'
      id: string
      terminalId: string
      epoch: string
      seq: number
      data: string
      inputSeq: number
      status: TerminalSummary['status']
    }
  | {
      type: 'terminal.exit'
      id: string
      terminalId: string
      epoch: string
      seq: number
      exitCode: number
    }
export function terminalRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
export function terminalKeys(v: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(v).every((k) => keys.includes(k))
}
export function terminalInteger(v: unknown, min = 0): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= min
}
export function terminalBytes(text: string): number {
  let bytes = 0
  for (const c of text) {
    const n = c.codePointAt(0) ?? 0
    bytes += n < 128 ? 1 : n < 2048 ? 2 : n < 65536 ? 3 : 4
  }
  return bytes
}
function dimensions(
  v: Record<string, unknown>,
): v is Record<string, unknown> & { cols: number; rows: number } {
  return (
    terminalInteger(v.cols, 2) &&
    v.cols <= TERMINAL_LIMITS.dimension &&
    terminalInteger(v.rows, 1) &&
    v.rows <= TERMINAL_LIMITS.dimension
  )
}
export function parseTerminalOp(v: unknown): TerminalOp | null {
  if (!terminalRecord(v)) return null
  if (v.type === 'terminal.create' && terminalKeys(v, ['type', 'cols', 'rows']) && dimensions(v))
    return { type: v.type, cols: v.cols, rows: v.rows }
  if (
    v.type === 'terminal.resize' &&
    terminalKeys(v, ['type', 'terminalId', 'cols', 'rows']) &&
    isUuid(v.terminalId) &&
    dimensions(v)
  )
    return { type: v.type, terminalId: v.terminalId, cols: v.cols, rows: v.rows }
  if (v.type === 'terminal.kill' && terminalKeys(v, ['type', 'terminalId']) && isUuid(v.terminalId))
    return { type: v.type, terminalId: v.terminalId }
  return null
}
export function parseTerminalInput(v: unknown): TerminalInput | null {
  return terminalRecord(v) &&
    terminalKeys(v, ['type', 'terminalId', 'seq', 'data']) &&
    v.type === 'terminal.input' &&
    isUuid(v.terminalId) &&
    terminalInteger(v.seq, 1) &&
    typeof v.data === 'string' &&
    terminalBytes(v.data) <= TERMINAL_LIMITS.inputBytes
    ? { type: v.type, terminalId: v.terminalId, seq: v.seq, data: v.data }
    : null
}
export function parseTerminalSubscribe(v: unknown): TerminalSubscribe | null {
  if (
    !terminalRecord(v) ||
    !terminalKeys(v, ['type', 'topic', 'id', 'terminalId', 'after']) ||
    v.type !== 'subscribe' ||
    v.topic !== 'terminal' ||
    typeof v.id !== 'string' ||
    !/^[A-Za-z0-9._-]{1,64}$/.test(v.id) ||
    !isUuid(v.terminalId)
  )
    return null
  let after: TerminalSubscribe['after']
  if (v.after !== undefined) {
    if (
      !terminalRecord(v.after) ||
      !terminalKeys(v.after, ['epoch', 'seq']) ||
      typeof v.after.epoch !== 'string' ||
      !/^[a-f0-9]{16}$/.test(v.after.epoch) ||
      !terminalInteger(v.after.seq)
    )
      return null
    after = { epoch: v.after.epoch, seq: v.after.seq }
  }
  return {
    type: 'subscribe',
    topic: 'terminal',
    id: v.id,
    terminalId: v.terminalId,
    ...(after ? { after } : {}),
  }
}
/** `{laneId}` lists that lane's shells; `{}` lists machine shells, which have no lane. */
export function parseTerminalListParams(v: unknown): { laneId: string | null } | null {
  if (!terminalRecord(v) || !terminalKeys(v, ['laneId'])) return null
  if (v.laneId === undefined) return { laneId: null }
  return isUuid(v.laneId) ? { laneId: v.laneId } : null
}
export function parseTerminalList(v: unknown): TerminalSummary[] | null {
  if (!Array.isArray(v) || v.length > TERMINAL_LIMITS.perHost) return null
  const result: TerminalSummary[] = []
  for (const row of v) {
    if (
      !terminalRecord(row) ||
      !terminalKeys(row, ['terminalId', 'laneId', 'status']) ||
      !isUuid(row.terminalId) ||
      // An empty laneId is a machine shell, which belongs to no lane.
      !(row.laneId === '' || isUuid(row.laneId)) ||
      (row.status !== 'running' && row.status !== 'exited' && row.status !== 'interrupted')
    )
      return null
    result.push({ terminalId: row.terminalId, laneId: row.laneId, status: row.status })
  }
  return result
}
export function parseTerminalFrame(v: unknown): TerminalFrame | null {
  if (!terminalRecord(v) || !isUuid(v.terminalId) || !terminalInteger(v.seq)) return null
  if (v.type === 'terminal.ack')
    return terminalKeys(v, ['type', 'terminalId', 'seq', 'accepted']) &&
      typeof v.accepted === 'boolean'
      ? { type: v.type, terminalId: v.terminalId, seq: v.seq, accepted: v.accepted }
      : null
  if (
    typeof v.id !== 'string' ||
    !/^[A-Za-z0-9._-]{1,64}$/.test(v.id) ||
    typeof v.epoch !== 'string' ||
    !/^[a-f0-9]{16}$/.test(v.epoch)
  )
    return null
  const common = { id: v.id, terminalId: v.terminalId, epoch: v.epoch, seq: v.seq }
  if (v.type === 'terminal.exit')
    return terminalKeys(v, ['type', 'id', 'terminalId', 'epoch', 'seq', 'exitCode']) &&
      typeof v.exitCode === 'number' &&
      Number.isSafeInteger(v.exitCode)
      ? { type: v.type, ...common, exitCode: v.exitCode }
      : null
  if (typeof v.data !== 'string') return null
  if (v.type === 'terminal.output')
    return terminalKeys(v, ['type', 'id', 'terminalId', 'epoch', 'seq', 'data']) &&
      terminalBytes(v.data) <= TERMINAL_LIMITS.chunkBytes
      ? { type: v.type, ...common, data: v.data }
      : null
  if (v.type === 'terminal.reset')
    return terminalKeys(v, [
      'type',
      'id',
      'terminalId',
      'epoch',
      'seq',
      'data',
      'status',
      'inputSeq',
    ]) &&
      terminalInteger(v.inputSeq) &&
      terminalBytes(v.data) <= TERMINAL_LIMITS.scrollbackBytes &&
      (v.status === 'running' || v.status === 'exited' || v.status === 'interrupted')
      ? { type: v.type, ...common, data: v.data, status: v.status, inputSeq: v.inputSeq }
      : null
  return null
}

export function parseTerminalCreated(v: unknown): { terminalId: string } | null {
  return terminalRecord(v) && terminalKeys(v, ['terminalId']) && isUuid(v.terminalId)
    ? { terminalId: v.terminalId }
    : null
}
