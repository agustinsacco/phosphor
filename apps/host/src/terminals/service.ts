import { PROVIDER_LOGIN_LIMITS } from '@phosphor/shared/host-protocol-providers'
import type { runInTerminal, TerminalRun } from '../machine/terminal'
import { randomUUID } from 'node:crypto'
import { userInfo } from 'node:os'
import { isAbsolute } from 'node:path'
import {
  TERMINAL_LIMITS as L,
  parseTerminalListParams,
  parseTerminalOp,
  parseTerminalInput,
  type TerminalOp,
  type TerminalInput,
  type TerminalSubscribe,
  type TerminalFrame,
} from '@phosphor/shared/host-protocol-terminals'
import type { HostFeature } from '../features/feature'
import { laneRoot } from '../features/files'
import {
  createTerminalState,
  FORCED_EXIT_CODE,
  type Entry,
  type TerminalOptions,
} from './service-state'
import { emit, output } from './output'
import { subscribe as subscribeTerminal } from './subscriptions'

export class TerminalForbidden extends Error {}
export function createTerminals(options: TerminalOptions) {
  const state = createTerminalState(options)
  const { entries, now } = state
  function persist() {
    options.save(
      [...entries.values()]
        .filter((entry) => !entry.login)
        .map(({ terminalId, laneId, status }) => ({
          terminalId,
          laneId,
          status,
        })),
    )
  }
  persist()
  function alive(laneId: string) {
    const lane = options.context.store.getLane(laneId)
    return (
      lane &&
      lane.removedAt === null &&
      options.context.store.listRepositories().some((r) => r.id === lane.repositoryId)
    )
  }
  function kill(entry: Entry, exitCode = FORCED_EXIT_CODE) {
    const pty = entry.pty
    entry.pty = undefined
    entry.status = 'exited'
    entry.login?.finish({ code: null })
    if (entry.login) {
      entry.chunks = []
      entry.outputBytes = 0
    }
    if (pty) {
      entry.exitCode = exitCode
      emit(entry, {
        type: 'terminal.exit',
        id: 'live',
        terminalId: entry.terminalId,
        epoch: options.epoch,
        seq: ++entry.seq,
        exitCode,
      })
    }
    try {
      pty?.kill()
    } catch {
      /* Already exited. */
    }
  }
  function reap() {
    let changed = false
    for (const [id, entry] of entries)
      if (
        entry.login
          ? entry.login.disconnectedAt !== undefined &&
            now() - entry.login.disconnectedAt >= PROVIDER_LOGIN_LIMITS.disconnectMs
          : !alive(entry.laneId)
      ) {
        kill(entry)
        entries.delete(id)
        entry.listeners.clear()
        changed = true
      }
    if (changed) persist()
  }
  // Deleted lanes lose their PTYs even when no client remains connected.
  state.timer = setInterval(() => {
    try {
      reap()
    } catch {
      close()
    }
  }, 1000)
  state.timer.unref()
  async function execute(
    laneId: string,
    input: TerminalOp,
    authorized: () => boolean = () => true,
  ): Promise<unknown> {
    if (!authorized()) throw new TerminalForbidden('forbidden')
    if (state.closed) throw new Error('unavailable')
    const op = parseTerminalOp(input)
    if (!op) throw new Error('bad-request')
    reap()
    const cwd = await laneRoot(options.context, laneId)
    if (!authorized()) throw new TerminalForbidden('forbidden')
    if (state.closed) throw new Error('unavailable')
    if (op.type === 'terminal.create') {
      // laneRoot awaits I/O: recheck limits after it, before any spawn.
      reap()
      if (!alive(laneId)) throw new Error('unknown-lane')
      if (
        entries.size >= L.perHost ||
        [...entries.values()].filter((e) => e.laneId === laneId).length >= L.perLane
      )
        throw new Error('too-many-requests')
      const shell = (options.shell ?? (() => userInfo().shell || '/bin/sh'))()
      if (!isAbsolute(shell) || shell.includes('\0')) throw new Error('unavailable')
      const entry: Entry = {
        terminalId: randomUUID(),
        laneId,
        status: 'running',
        seq: 0,
        inputSeq: 0,
        window: 0,
        bytes: 0,
        chunks: [],
        outputBytes: 0,
        listeners: new Set(),
      }
      entries.set(entry.terminalId, entry)
      // Record identity before spawn. A crash can only restore an interrupted terminal.
      try {
        persist()
        entry.pty = options.native.spawn(shell, ['-l'], {
          cwd,
          cols: op.cols,
          rows: op.rows,
          name: 'xterm-256color',
          env: { ...options.env, TERM: 'xterm-256color' },
        })
        entry.pty.onData((data) => output(state, entry, data))
        entry.pty.onExit(({ exitCode }) => {
          if (entry.status !== 'running') return
          entry.pty = undefined
          entry.status = 'exited'
          emit(entry, {
            type: 'terminal.exit',
            id: 'live',
            terminalId: entry.terminalId,
            epoch: options.epoch,
            seq: ++entry.seq,
            exitCode,
          })
          try {
            persist()
          } catch {
            close()
          }
        })
      } catch {
        kill(entry)
        entries.delete(entry.terminalId)
        persist()
        throw new Error('unavailable')
      }
      return { terminalId: entry.terminalId }
    }
    const entry = entries.get(op.terminalId)
    if (!entry || entry.laneId !== laneId) throw new Error('bad-request')
    if (op.type === 'terminal.resize') {
      if (!entry.pty) throw new Error('unavailable')
      entry.pty.resize(op.cols, op.rows)
    } else {
      kill(entry)
      entries.delete(entry.terminalId)
      entry.listeners.clear()
      persist()
    }
    return null
  }
  function input(clientId: string, raw: TerminalInput): boolean {
    if (state.closed) return false
    const frame = parseTerminalInput(raw)
    if (!frame) return false
    const entry = entries.get(frame.terminalId)
    if (!entry || (!entry.login && !alive(entry.laneId)) || !entry.pty) return false
    const lane = options.context.store.getLane(entry.laneId)
    if (
      (entry.login
        ? entry.login.owner !== clientId
        : lane?.control.controller?.clientId !== clientId) ||
      frame.seq !== entry.inputSeq + 1
    )
      return false
    const time = now()
    if (time - entry.window >= 1000) {
      entry.window = time
      entry.bytes = 0
    }
    const bytes = Buffer.byteLength(frame.data)
    if (entry.bytes + bytes > L.inputBytesPerSecond) return false
    // Consume before write, including uncertain writes. No retries or replay.
    entry.inputSeq = frame.seq
    entry.bytes += bytes
    try {
      entry.pty.write(frame.data)
      return true
    } catch {
      return false
    }
  }
  function subscribe(
    frame: TerminalSubscribe,
    send: (frame: TerminalFrame) => void,
    clientId?: string,
  ) {
    return subscribeTerminal(state, reap, frame, send, clientId)
  }
  const feature: HostFeature = {
    capability: 'terminal',
    methods: ['terminal.list'],
    async call(method, params) {
      if (state.closed)
        return { ok: false, error: { code: 'internal', message: 'Terminals unavailable.' } }
      const parsed = parseTerminalListParams(params)
      if (method !== 'terminal.list' || !parsed)
        return { ok: false, error: { code: 'bad-request', message: 'Invalid terminal request.' } }
      try {
        reap()
        await laneRoot(options.context, parsed.laneId)
        return {
          ok: true,
          data: [...entries.values()]
            .filter((e) => e.laneId === parsed.laneId)
            .map(({ terminalId, laneId, status }) => ({ terminalId, laneId, status })),
        }
      } catch {
        return { ok: false, error: { code: 'unknown-lane', message: 'Lane unavailable.' } }
      }
    },
  }
  function close() {
    state.closed = true
    clearInterval(state.timer)
    for (const entry of entries.values()) {
      kill(entry)
      entry.listeners.clear()
    }
  }
  function presence(owner: string, connected: boolean, revoked = false) {
    for (const [id, entry] of entries) {
      if (entry.login?.owner !== owner) continue
      if (revoked) {
        kill(entry)
        entry.listeners.clear()
        entries.delete(id)
      } else if (entry.status === 'running')
        entry.login.disconnectedAt = connected ? undefined : now()
    }
  }
  function machineOp(owner: string, op: TerminalOp) {
    if (state.closed || op.type === 'terminal.create') throw new TerminalForbidden('forbidden')
    const entry = entries.get(op.terminalId)
    if (!entry?.login || entry.login.owner !== owner) throw new TerminalForbidden('forbidden')
    if (op.type === 'terminal.resize') entry.pty?.resize(op.cols, op.rows)
    else {
      kill(entry)
      entries.delete(entry.terminalId)
      entry.listeners.clear()
    }
    return null
  }
  /** Only the Host's CLI login runner supplies these process options. Never wire input. */
  function loginRunner(owner: string, started: (id: string) => void): typeof runInTerminal {
    return (file, args, settings) =>
      new Promise<TerminalRun>((resolve) => {
        if (state.closed || entries.size >= L.perHost)
          return resolve({ code: null, error: 'unavailable' })
        const entry: Entry = {
          terminalId: randomUUID(),
          laneId: '',
          status: 'running',
          seq: 0,
          inputSeq: 0,
          window: 0,
          bytes: 0,
          chunks: [],
          outputBytes: 0,
          listeners: new Set(),
          login: { owner, finish: resolve },
        }
        entries.set(entry.terminalId, entry)
        try {
          entry.pty = options.native.spawn(file, [...args], {
            cwd: settings.cwd,
            env: settings.env,
            cols: 80,
            rows: 24,
            name: 'xterm-256color',
          })
          entry.pty.onData((data) => output(state, entry, data))
          entry.pty.onExit(({ exitCode }) => {
            const watched = entry.listeners.size > 0
            kill(entry, exitCode)
            // An exit can beat Desktop's first subscribe. Retain only a bounded,
            // content-free tombstone so its reset reports completion, not a hung modal.
            if (entry.login) entry.login.disconnectedAt = now()
            if (watched) entries.delete(entry.terminalId)
            entry.listeners.clear()
          })
          started(entry.terminalId)
        } catch {
          kill(entry)
          entries.delete(entry.terminalId)
          resolve({ code: null, error: 'unavailable' })
        }
      })
  }
  return { execute, input, subscribe, feature, close, loginRunner, machineOp, presence }
}
export type HostTerminals = ReturnType<typeof createTerminals>
