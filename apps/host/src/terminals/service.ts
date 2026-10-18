import { PROVIDER_LOGIN_LIMITS } from '@phosphor/shared/host-protocol-providers'
import type { runInTerminal, TerminalRun } from '../machine/terminal'
import { randomUUID } from 'node:crypto'
import { userInfo } from 'node:os'
import { isAbsolute } from 'node:path'
import {
  TERMINAL_LIMITS as L,
  parseTerminalList,
  parseTerminalListParams,
  parseTerminalOp,
  parseTerminalInput,
  type TerminalOp,
  type TerminalInput,
  type TerminalSubscribe,
  type TerminalFrame,
  type TerminalSummary,
} from '@phosphor/shared/host-protocol-terminals'
import type { HostFeature, FeatureContext } from '../features/feature'
import { laneRoot } from '../features/files'
import type { HostPty, HostPtyModule } from './native'

export class TerminalForbidden extends Error {}
/** A stop the Host forces has no observed code. The numeric wire reports it as -1, never a clean 0. */
const FORCED_EXIT_CODE = -1

type Entry = TerminalSummary & {
  login?: {
    owner: string
    configuration?: boolean
    deferExit?: boolean
    authorized?: () => boolean
    nativeExitCode?: number
    disconnectedAt?: number
    finish: (result: TerminalRun) => void
  }
  pty?: HostPty
  /** The code kill() reported, which a login's tombstone repeats. */
  exitCode?: number
  seq: number
  inputSeq: number
  window: number
  bytes: number
  chunks: { seq: number; data: string; bytes: number }[]
  outputBytes: number
  listeners: Set<(frame: TerminalFrame) => void>
}
export function createTerminals(options: {
  native: HostPtyModule
  context: FeatureContext
  env: Record<string, string>
  epoch: string
  now?: () => number
  shell?: () => string
  load(): unknown
  save(rows: TerminalSummary[]): void
}) {
  let closed = false
  const entries = new Map<string, Entry>()
  const now = options.now ?? Date.now
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
  const restored = parseTerminalList(options.load())
  if (!restored) throw new Error('Invalid terminal state')
  for (const row of restored)
    entries.set(row.terminalId, {
      ...row,
      status: row.status === 'running' ? 'interrupted' : row.status,
      seq: 0,
      inputSeq: 0,
      window: 0,
      bytes: 0,
      chunks: [],
      outputBytes: 0,
      listeners: new Set(),
    })
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
    const wasRunning = entry.status === 'running'
    entry.pty = undefined
    entry.status = 'exited'
    entry.login?.finish({ code: exitCode === FORCED_EXIT_CODE ? null : exitCode })
    if (entry.login) {
      entry.chunks = []
      entry.outputBytes = 0
    }
    if (pty || wasRunning) {
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
  const timer = setInterval(() => {
    try {
      reap()
    } catch {
      close()
    }
  }, 1000)
  timer.unref()
  function emit(entry: Entry, frame: TerminalFrame) {
    for (const listener of [...entry.listeners]) {
      try {
        listener(frame)
      } catch {
        entry.listeners.delete(listener)
      }
    }
  }
  function output(entry: Entry, data: string) {
    if (entry.login && (closed || entry.status !== 'running')) return
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
        epoch: options.epoch,
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
  async function execute(
    laneId: string,
    input: TerminalOp,
    authorized: () => boolean = () => true,
  ): Promise<unknown> {
    if (!authorized()) throw new TerminalForbidden('forbidden')
    if (closed) throw new Error('unavailable')
    const op = parseTerminalOp(input)
    if (!op) throw new Error('bad-request')
    reap()
    const cwd = await laneRoot(options.context, laneId)
    if (!authorized()) throw new TerminalForbidden('forbidden')
    if (closed) throw new Error('unavailable')
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
        entry.pty.onData((data) => output(entry, data))
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
  function input(clientId: string, raw: TerminalInput, configuration = false): boolean {
    if (closed) return false
    const frame = parseTerminalInput(raw)
    if (!frame) return false
    const entry = entries.get(frame.terminalId)
    if (
      !entry ||
      (entry.login?.configuration && !configuration) ||
      (!entry.login && !alive(entry.laneId)) ||
      !entry.pty
    )
      return false
    const lane = entry.login ? null : options.context.store.getLane(entry.laneId)
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
    configuration: () => boolean = () => false,
  ): (() => void) | null {
    if (closed) return null
    reap()
    const entry = entries.get(frame.terminalId)
    if (
      !entry ||
      (entry.login?.configuration && !configuration()) ||
      (entry.login && entry.login.owner !== clientId)
    )
      return null
    if (entry.login && entry.status === 'running') entry.login.disconnectedAt = undefined
    const deliver = (f: TerminalFrame) => {
      if (!entry.login?.configuration || configuration())
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
  const feature: HostFeature = {
    capability: 'terminal',
    methods: ['terminal.list'],
    async call(method, params) {
      if (closed)
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
    closed = true
    clearInterval(timer)
    for (const entry of entries.values()) {
      kill(entry)
      entry.listeners.clear()
    }
  }
  function authorizationChanged() {
    for (const [id, entry] of entries) {
      if (entry.login?.configuration && entry.login.authorized && !entry.login.authorized()) {
        kill(entry)
        entry.listeners.clear()
        entries.delete(id)
      }
    }
  }
  function presence(owner: string, connected: boolean, revoked = false) {
    authorizationChanged()
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
  function machineOp(owner: string, op: TerminalOp, configuration = false) {
    if (closed || op.type === 'terminal.create') throw new TerminalForbidden('forbidden')
    const entry = entries.get(op.terminalId)
    if (
      !entry?.login ||
      entry.login.owner !== owner ||
      (entry.login.configuration && !configuration && op.type !== 'terminal.kill')
    )
      throw new TerminalForbidden('forbidden')
    if (op.type === 'terminal.resize') entry.pty?.resize(op.cols, op.rows)
    else {
      kill(entry)
      entries.delete(entry.terminalId)
      entry.listeners.clear()
    }
    return null
  }
  function finishLogin(entry: Entry, exitCode: number) {
    const watched = entry.listeners.size > 0
    kill(entry, exitCode)
    if (entry.login) entry.login.disconnectedAt = now()
    if (watched) entries.delete(entry.terminalId)
    entry.listeners.clear()
  }
  /** Internal only: keep the private stream open until authoritative auth/metadata verification ends. */
  function completeLogin(owner: string, id: string, exitCode: number) {
    const entry = entries.get(id)
    if (
      entry?.login?.owner === owner &&
      entry.login.deferExit &&
      entry.login.nativeExitCode !== undefined
    )
      finishLogin(entry, exitCode)
  }
  /** Only the Host's CLI login runner supplies these process options. Never wire input. */
  function loginRunner(
    owner: string,
    started: (id: string) => void,
    configuration = false,
    deferExit = false,
    authorized?: () => boolean,
  ): typeof runInTerminal {
    return (file, args, settings) =>
      new Promise<TerminalRun>((resolve) => {
        if (closed || entries.size >= L.perHost)
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
          login: { owner, configuration, deferExit, authorized, finish: resolve },
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
          entry.pty.onData((data) => output(entry, data))
          entry.pty.onExit(({ exitCode }) => {
            if (entry.login?.deferExit) {
              entry.pty = undefined
              entry.login.nativeExitCode = exitCode
              entry.login.finish({ code: exitCode })
            } else finishLogin(entry, exitCode)
            // A completed stream may beat Desktop's subscribe; its bounded,
            // content-free tombstone still reports completion, not a hung modal.
          })
          started(entry.terminalId)
        } catch {
          kill(entry)
          entries.delete(entry.terminalId)
          resolve({ code: null, error: 'unavailable' })
        }
      })
  }
  return {
    execute,
    input,
    subscribe,
    feature,
    close,
    loginRunner,
    completeLogin,
    machineOp,
    presence,
    authorizationChanged,
  }
}
export type HostTerminals = ReturnType<typeof createTerminals>
