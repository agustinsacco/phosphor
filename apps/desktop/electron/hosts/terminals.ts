import { randomUUID } from 'node:crypto'
import {
  parseTerminalCreated,
  parseTerminalList,
  parseTerminalOp,
  TERMINAL_LIMITS,
  terminalBytes,
} from '@shared/host-protocol-terminals'
import type { IpcInvokeChannel } from '@shared/ipc'
import type { createHostConnection } from './connection'
import { REMOTE_UNAVAILABLE } from './lane-ops'

type Connection = ReturnType<typeof createHostConnection>
export interface TerminalLane {
  hostId: string
  laneId: string
  connection: Connection
  current: () => boolean
}
type Entry = {
  id: string
  windowId: number
  sessionId: string
  workspace: string
  lane: TerminalLane
  terminalId: string
  epoch: string
  generation: number
  inputSeq: number
  cursor?: { epoch: string; seq: number }
  synchronized: boolean
  resetVersion: number
  ended: boolean
  busy: boolean
  watch?: ReturnType<Connection['watchTerminal']>
}

/** Main owns identities and input sequencing. Input never enters the receipt replay queue. */
export function createRemoteTerminals(ports: {
  lane: (windowId: number, sessionId: string, workspace: string) => TerminalLane
  clientId: () => string | null
  inputDropped?: () => void
  emit: (windowId: number, channel: string, value: string | number) => void
}) {
  const entries = new Map<string, Entry>()
  function valid(e: Entry) {
    const c = e.lane.connection
    return (
      e.lane.current() &&
      c.incarnation().runtimeEpoch === e.epoch &&
      c.snapshot().state === 'ready' &&
      c.snapshot().capabilities.includes('terminal')
    )
  }
  function control(lane: TerminalLane) {
    const view = lane.connection.snapshot()
    return (
      view.capabilities.includes('sessions.control') &&
      view.lanes.find((l) => l.laneId === lane.laneId)?.control.controller?.clientId ===
        ports.clientId()
    )
  }
  function owned(windowId: number, id: string) {
    const e = entries.get(id)
    if (!e || e.windowId !== windowId || !valid(e)) throw new Error(REMOTE_UNAVAILABLE)
    return e
  }
  function writable(e: Entry) {
    if (
      !valid(e) ||
      !control(e.lane) ||
      !e.synchronized ||
      e.ended ||
      e.generation !== e.lane.connection.incarnation().generation
    )
      throw new Error('Read-only. Take control to send messages.')
  }
  async function mutate(e: Entry, op: unknown) {
    writable(e)
    const parsed = parseTerminalOp(op)
    if (!parsed) throw new Error('Invalid terminal request.')
    const c = e.lane.connection
    const generation = c.incarnation().generation
    const fence = c.snapshot().lanes.find((l) => l.laneId === e.lane.laneId)?.control.fence
    const result = await c.send(parsed, e.lane.laneId, fence)
    writable(e)
    if (generation !== c.incarnation().generation || result.status !== 'done')
      throw new Error('Terminal operation not confirmed.')
  }
  async function create(
    windowId: number,
    workspace: string,
    cols: number,
    rows: number,
    sessionId: string,
  ) {
    const lane = ports.lane(windowId, sessionId, workspace)
    const c = lane.connection
    const incarnation = c.incarnation()
    if (
      !lane.current() ||
      c.snapshot().state !== 'ready' ||
      !c.snapshot().capabilities.includes('terminal')
    )
      throw new Error(REMOTE_UNAVAILABLE)
    const op = parseTerminalOp({ type: 'terminal.create', cols, rows })
    if (!op) throw new Error('Invalid terminal request.')
    if (entries.size >= TERMINAL_LIMITS.perHost * 32) throw new Error('Terminal limit reached.')
    const controlling = control(lane)
    const result = controlling
      ? await c.send(
          op,
          lane.laneId,
          c.snapshot().lanes.find((l) => l.laneId === lane.laneId)?.control.fence,
        )
      : await c.call('terminal.list', { laneId: lane.laneId })
    if (
      !lane.current() ||
      c.snapshot().state !== 'ready' ||
      !c.snapshot().capabilities.includes('terminal') ||
      c.incarnation().generation !== incarnation.generation ||
      (controlling && !control(lane))
    )
      throw new Error(REMOTE_UNAVAILABLE)
    const created =
      'status' in result && result.status === 'done' ? parseTerminalCreated(result.data) : null
    const list = 'ok' in result && result.ok ? parseTerminalList(result.data) : null
    const terminalId =
      created?.terminalId ?? list?.find((t) => t.laneId === lane.laneId)?.terminalId
    if (!terminalId)
      throw new Error(
        controlling ? 'Terminal creation not confirmed.' : 'Read-only: no terminals available.',
      )
    const existing = [...entries.values()].find(
      (e) => e.lane.connection === c && e.terminalId === terminalId,
    )
    if (existing) {
      if (existing.windowId !== windowId || existing.sessionId !== sessionId)
        throw new Error(REMOTE_UNAVAILABLE)
      return { ptyId: existing.id }
    }
    const id = `remote-pty-${randomUUID()}`
    entries.set(id, {
      id,
      windowId,
      sessionId,
      workspace,
      lane,
      terminalId,
      epoch: incarnation.runtimeEpoch,
      generation: incarnation.generation,
      inputSeq: 0,
      synchronized: false,
      resetVersion: 0,
      ended: false,
      busy: false,
    })
    return { ptyId: id }
  }
  function attach(windowId: number, id: string): Promise<{ scrollback: string }> {
    const e = owned(windowId, id)
    e.watch?.close()
    e.synchronized = false
    return new Promise((resolve, reject) => {
      let initial = true
      const timer = setTimeout(() => reject(new Error('Terminal unavailable.')), 5000)
      timer.unref()
      e.watch = e.lane.connection.watchTerminal(e.terminalId, (frame) => {
        if (!valid(e)) return
        if (frame.type === 'subscribe-failed') {
          e.synchronized = false
          clearTimeout(timer)
          reject(new Error(REMOTE_UNAVAILABLE))
          return
        }
        if (frame.type === 'terminal.ack') return
        if (frame.type === 'terminal.reset') {
          e.resetVersion++
          e.cursor = { epoch: frame.epoch, seq: frame.seq }
          e.inputSeq = frame.inputSeq
          e.generation = e.lane.connection.incarnation().generation
          e.synchronized = true
          e.ended = frame.status !== 'running'
          clearTimeout(timer)
          if (initial) {
            initial = false
            resolve({ scrollback: frame.data })
          } else ports.emit(windowId, `pty:data:${id}`, `\x1bc${frame.data}`)
          if (e.ended)
            setTimeout(() => {
              if (valid(e)) ports.emit(windowId, `pty:exit:${id}`, 0)
            }, 0)
          return
        }
        if (!e.synchronized || e.generation !== e.lane.connection.incarnation().generation) return
        if (e.cursor?.epoch === frame.epoch && frame.seq <= e.cursor.seq) return
        if (!e.cursor || e.cursor.epoch !== frame.epoch || frame.seq !== e.cursor.seq + 1) {
          e.synchronized = false
          e.watch?.reset()
          return
        }
        e.cursor = { epoch: frame.epoch, seq: frame.seq }
        if (frame.type === 'terminal.output') ports.emit(windowId, `pty:data:${id}`, frame.data)
        else {
          e.ended = true
          ports.emit(windowId, `pty:exit:${id}`, frame.exitCode)
        }
      })
    })
  }
  async function write(windowId: number, id: string, data: string) {
    const e = owned(windowId, id)
    writable(e)
    // Reject concurrent or oversized IPC writes rather than retaining a private input queue.
    if (e.busy || typeof data !== 'string' || terminalBytes(data) > 64 * 1024)
      throw new Error('Terminal input refused.')
    e.busy = true
    try {
      let chunk = ''
      let bytes = 0
      const chunks: string[] = []
      for (const char of data) {
        const size = terminalBytes(char)
        if (bytes + size > TERMINAL_LIMITS.inputBytes) {
          chunks.push(chunk)
          chunk = ''
          bytes = 0
        }
        chunk += char
        bytes += size
      }
      if (chunk) chunks.push(chunk)
      for (const text of chunks) {
        writable(e)
        const generation = e.generation
        const resetVersion = e.resetVersion
        const seq = e.inputSeq + 1
        const accepted = await e.lane.connection.input(e.terminalId, seq, text)
        if (
          !valid(e) ||
          generation !== e.lane.connection.incarnation().generation ||
          resetVersion !== e.resetVersion
        ) {
          // A reset may beat this continuation. Never overwrite its fresh sequence or readiness.
          if (resetVersion === e.resetVersion) e.synchronized = false
          else if (generation === e.lane.connection.incarnation().generation) {
            if (accepted) e.inputSeq = Math.max(e.inputSeq, seq)
            else {
              e.synchronized = false
              e.watch?.reset()
            }
          }
          ports.inputDropped?.()
          return
        }
        if (!accepted) {
          ports.inputDropped?.()
          e.synchronized = false
          e.watch?.reset()
          return
        }
        e.inputSeq = seq
        writable(e)
      }
    } finally {
      e.busy = false
    }
  }
  function reconcile() {
    for (const [id, e] of entries) {
      if (!e.lane.current() || e.epoch !== e.lane.connection.incarnation().runtimeEpoch) {
        e.watch?.close()
        entries.delete(id)
        ports.emit(e.windowId, `pty:exit:${id}`, 0)
      } else if (
        e.generation !== e.lane.connection.incarnation().generation ||
        e.lane.connection.snapshot().state !== 'ready'
      )
        e.synchronized = false
    }
  }
  return {
    reconcile,
    clear(windowId?: number) {
      for (const [id, e] of entries)
        if (windowId === undefined || e.windowId === windowId) {
          e.watch?.close()
          entries.delete(id)
        }
    },
    route(
      windowId: number,
      channel: IpcInvokeChannel,
      args: unknown[],
    ): { result: Promise<unknown> } | null {
      const [id, a, b, sessionId] = args
      if (channel === 'pty:create' && typeof id === 'string' && id.startsWith('host:')) {
        if (typeof a !== 'number' || typeof b !== 'number' || typeof sessionId !== 'string')
          throw new Error(REMOTE_UNAVAILABLE)
        return { result: create(windowId, id, a, b, sessionId) }
      }
      if (typeof id !== 'string' || !id.startsWith('remote-pty-') || !channel.startsWith('pty:'))
        return null
      const result = (async () => {
        if (channel === 'pty:attach') return attach(windowId, id)
        if (channel === 'pty:write') {
          if (typeof a !== 'string') throw new Error('Invalid terminal request.')
          return write(windowId, id, a)
        }
        const e = owned(windowId, id)
        if (channel === 'pty:resize')
          return mutate(e, { type: 'terminal.resize', terminalId: e.terminalId, cols: a, rows: b })
        if (channel === 'pty:kill') {
          await mutate(e, { type: 'terminal.kill', terminalId: e.terminalId })
          e.watch?.close()
          entries.delete(id)
          return
        }
        throw new Error(REMOTE_UNAVAILABLE)
      })()
      return { result }
    },
  }
}
