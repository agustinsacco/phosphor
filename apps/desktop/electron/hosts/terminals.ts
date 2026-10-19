import { createMachinePrograms } from './machine-programs'
import {
  createTerminalEntry,
  type TerminalConnection as Connection,
  type TerminalLane,
  type RemoteTerminalEntry as Entry,
  type TerminalAdmission,
} from './terminal-state'

export type { TerminalLane } from './terminal-state'
import {
  parseTerminalCreated,
  parseTerminalList,
  parseTerminalOp,
  TERMINAL_LIMITS,
  terminalBytes,
} from '@shared/host-protocol-terminals'
import type { IpcInvokeChannel } from '@shared/ipc'
import { REMOTE_UNAVAILABLE } from './lane-ops'

/** Main owns identities and input sequencing. Input never enters the receipt replay queue. */
export function createRemoteTerminals(ports: {
  connection?: (hostId: string) => Connection | undefined
  lane: (windowId: number, sessionId: string, workspace: string) => TerminalLane
  clientId: () => string | null
  inputDropped?: () => void
  emit: (windowId: number, channel: string, value: string | number) => void
}) {
  const entries = new Map<string, Entry>()
  const admissions = new Set<TerminalAdmission>()
  function dropPending(e: Entry) {
    if (!e.pending.length) return
    e.dropVersion++
    ports.inputDropped?.()
    for (const item of e.pending) item.reject(new Error('Terminal input dropped.'))
    e.pending = []
    e.pendingBytes = 0
  }
  function valid(e: Entry) {
    const c = e.lane.connection
    return (
      entries.get(e.id) === e &&
      e.lane.current() &&
      c.incarnation().runtimeEpoch === e.epoch &&
      c.snapshot().state === 'ready' &&
      c.snapshot().capabilities.includes('terminal') &&
      (!e.lane.configuration || c.snapshot().capabilities.includes('machine.configure'))
    )
  }
  function control(lane: TerminalLane) {
    const view = lane.connection.snapshot()
    return (
      view.capabilities.includes('sessions.control') &&
      (lane.machine ||
        view.lanes.find((l) => l.laneId === lane.laneId)?.control.controller?.clientId ===
          ports.clientId())
    )
  }
  function owned(windowId: number, id: string) {
    const e = entries.get(id)
    if (!e || e.killing || e.windowId !== windowId || !valid(e)) throw new Error(REMOTE_UNAVAILABLE)
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
    const result = await c.send(
      parsed,
      e.lane.machine ? undefined : e.lane.laneId,
      e.lane.machine ? undefined : fence,
    )
    writable(e)
    if (generation !== c.incarnation().generation || result.status !== 'done')
      throw new Error('Terminal operation not confirmed.')
  }
  function dispose(e: Entry) {
    dropPending(e)
    e.watch?.close()
    e.watch = undefined
    entries.delete(e.id)
  }
  async function flushKill(e: Entry) {
    const c = e.lane.connection
    if (!e.lane.current() || c.incarnation().runtimeEpoch !== e.epoch || e.ended) {
      dispose(e)
      return
    }
    if (e.killBusy || !valid(e) || !control(e.lane)) return
    e.killBusy = true
    try {
      const fence = c.snapshot().lanes.find((l) => l.laneId === e.lane.laneId)?.control.fence
      const result = await c.send(
        { type: 'terminal.kill', terminalId: e.terminalId },
        e.lane.machine ? undefined : e.lane.laneId,
        e.lane.machine ? undefined : fence,
      )
      if (result.status === 'done') dispose(e)
      else if (!e.watch && valid(e))
        e.watch = c.watchTerminal(e.terminalId, (frame) => {
          if (
            (frame.type === 'subscribe-failed' && frame.code === 'unknown-lane') ||
            frame.type === 'terminal.exit' ||
            (frame.type === 'terminal.reset' && frame.status !== 'running')
          )
            dispose(e)
          else if (frame.type === 'subscribe-failed') {
            e.watch?.close()
            e.watch = undefined
          }
        })
    } catch {
      // The bounded entry retains cleanup intent until the connection returns.
    } finally {
      e.killBusy = false
    }
  }
  async function kill(windowId: number, id: string) {
    const e = entries.get(id)
    if (!e) return
    if (e.windowId !== windowId) throw new Error(REMOTE_UNAVAILABLE)
    if (!e.lane.machine && !control(e.lane))
      throw new Error('Read-only. Take control to send messages.')
    if (
      e.lane.connection.snapshot().state === 'ready' &&
      (!valid(e) || !control(e.lane)) &&
      !e.ended
    )
      throw new Error(REMOTE_UNAVAILABLE)
    e.killing = true
    dropPending(e)
    e.watch?.close()
    e.watch = undefined
    await flushKill(e)
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
    if (entries.size + admissions.size >= TERMINAL_LIMITS.perHost * 32)
      throw new Error('Terminal limit reached.')
    const admission = { windowId, cancelled: false }
    admissions.add(admission)
    const controlling = control(lane)
    let result
    try {
      result = controlling
        ? await c.send(
            op,
            lane.laneId,
            c.snapshot().lanes.find((l) => l.laneId === lane.laneId)?.control.fence,
          )
        : await c.call('terminal.list', { laneId: lane.laneId })
    } finally {
      admissions.delete(admission)
    }
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
    const entry = createTerminalEntry({
      windowId,
      sessionId,
      workspace,
      lane,
      terminalId,
      epoch: incarnation.runtimeEpoch,
      generation: incarnation.generation,
    })
    entries.set(entry.id, entry)
    return { ptyId: entry.id }
  }

  const programs = createMachinePrograms({
    connection: ports.connection,
    control,
    entries,
    admissions,
    flushKill,
  })
  function attach(windowId: number, id: string): Promise<{ scrollback: string }> {
    const e = owned(windowId, id)
    e.watch?.close()
    e.synchronized = false
    return new Promise((resolve, reject) => {
      let initial = true
      let closed = false
      const timer = setTimeout(() => {
        closed = true
        // A superseded attach only settles itself; the newer watch owns the entry.
        if (e.watch !== watch) return reject(new Error('Terminal unavailable.'))
        e.watch?.close()
        e.synchronized = false
        dropPending(e)
        reject(new Error('Terminal unavailable.'))
      }, 5000)
      timer.unref()
      const watch = (e.watch = e.lane.connection.watchTerminal(e.terminalId, (frame) => {
        if (closed || !valid(e)) return
        if (frame.type === 'subscribe-failed') {
          closed = true
          e.watch?.close()
          e.synchronized = false
          clearTimeout(timer)
          reject(new Error(REMOTE_UNAVAILABLE))
          return
        }
        if (frame.type === 'terminal.ack') return
        if (frame.type === 'terminal.reset') {
          dropPending(e)
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
        else if (!e.ended) {
          e.ended = true
          ports.emit(windowId, `pty:exit:${id}`, frame.exitCode)
        }
      }))
    })
  }
  async function write(windowId: number, id: string, data: string) {
    const e = owned(windowId, id)
    writable(e)
    if (typeof data !== 'string' || terminalBytes(data) > 64 * 1024)
      throw new Error('Terminal input refused.')
    if (e.busy) {
      if (e.pendingBytes + terminalBytes(data) > 64 * 1024)
        throw new Error('Terminal input refused.')
      return new Promise<void>((resolve, reject) => {
        e.pending.push({ data, resolve, reject })
        e.pendingBytes += terminalBytes(data)
      })
    }
    e.busy = true
    const dropVersion = e.dropVersion
    try {
      let queued: Entry['pending'][number] | undefined
      do {
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
            if (!e.pending.length && dropVersion === e.dropVersion) ports.inputDropped?.()
            return
          }
          if (!accepted) {
            if (!e.pending.length && dropVersion === e.dropVersion) ports.inputDropped?.()
            e.synchronized = false
            e.watch?.reset()
            return
          }
          e.inputSeq = seq
          if (dropVersion !== e.dropVersion) return
          writable(e)
        }
        if (queued && e.pending[0] === queued) {
          const item = e.pending.shift()!
          e.pendingBytes -= terminalBytes(item.data)
          item.resolve()
        }
        if (!e.pending.length) break
        queued = e.pending[0]!
        data = queued.data
      } while (queued)
    } catch {
      if (!e.pending.length && dropVersion === e.dropVersion) ports.inputDropped?.()
    } finally {
      dropPending(e)
      e.busy = false
    }
  }
  function reconcile() {
    for (const [id, e] of entries) {
      if (
        e.lane.configuration &&
        !e.lane.connection.snapshot().capabilities.includes('machine.configure')
      ) {
        dropPending(e)
        e.watch?.close()
        entries.delete(id)
        ports.emit(e.windowId, `pty:exit:${id}`, -1)
        continue
      }
      if (e.killing) {
        void flushKill(e)
        continue
      }
      if (
        !valid(e) ||
        !control(e.lane) ||
        e.generation !== e.lane.connection.incarnation().generation
      )
        dropPending(e)
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
    signIn: programs.signIn,
    task: programs.task,
    reconcile,
    clear(windowId?: number) {
      for (const a of admissions)
        if (windowId === undefined || a.windowId === windowId) a.cancelled = true
      for (const e of entries.values())
        if (windowId === undefined || e.windowId === windowId) {
          if (e.lane.machine && !e.ended) {
            e.killing = true
            e.watch?.close()
            e.watch = undefined
            void flushKill(e)
          } else dispose(e)
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
        if (channel === 'pty:kill') return kill(windowId, id)
        const e = owned(windowId, id)
        if (channel === 'pty:resize')
          return mutate(e, { type: 'terminal.resize', terminalId: e.terminalId, cols: a, rows: b })
        throw new Error(REMOTE_UNAVAILABLE)
      })()
      return { result }
    },
  }
}
