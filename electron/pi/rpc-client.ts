import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { JsonlDecoder } from './jsonl'
import { SessionActivity } from './session-activity'
import { shutdownApproval } from '../shutdown-approval'
import {
  decodeOmpFrame,
  encodeOmpCommand,
  OMP_DEFAULT_MAX_REASSEMBLED_BYTES,
  OMP_PROTOCOL_V2,
  OmpChunkDecoder,
  type OmpChunkError,
  OmpEndedTools,
  offersProtocolV2,
  ompNegotiateCommand,
  ompRpcArgs,
  ompSubagentSnapshots,
  ompSubagentSubscriptionCommand,
  type OmpReadyFrame,
} from './omp-dialect'
import type { AgentKind } from '@shared/models'
import {
  isOmpSubagentFrame,
  type OmpSubagentFrame,
  type OmpSubagentSnapshot,
  type OmpSubagentSubscriptionLevel,
} from '@shared/omp-subagents'
import type {
  ExtensionUIRequest,
  ExtensionUIResponse,
  PiEvent,
  RpcCommand,
  RpcResponse,
  RpcResponseDataMap,
} from '@shared/rpc'
import { log } from '../debug-log'

export interface PiSpawnOptions {
  /** Workspace folder — becomes the agent's cwd. */
  cwd: string
  /**
   * Which agent `binaryPath` is: decides the argv and whether the wire is
   * translated (`omp-dialect.ts`). Defaults to pi.
   */
  agent?: AgentKind
  /** Agent binary; defaults to the agent's name ("pi" or "omp") resolved via PATH. */
  binaryPath?: string
  /**
   * Args inserted before `--mode rpc`. Lets callers run pi through an
   * interpreter (tests use `node fake-pi.cjs`; Windows npm shims may need it).
   */
  prefixArgs?: string[]
  /** Resume an existing session file or id (`--session`). */
  sessionPath?: string
  /** Fork from a session file or id (`--fork`). */
  forkFrom?: string
  /** Fixed session id (`--session-id`). pi only. */
  sessionId?: string
  /** Display name (`-n`). pi only; an omp session is named over RPC instead. */
  name?: string
  /** Model pattern (`--model`). */
  model?: string
  /** Provider (`--provider`). */
  provider?: string
  /** Thinking level (`--thinking`). */
  thinkingLevel?: string
  /** Extension files to load (`-e`, repeatable). */
  extensions?: string[]
  /** Append to system prompt (`--append-system-prompt`). */
  appendSystemPrompt?: string
  /** Disable session persistence (`--no-session`). */
  noSession?: boolean
  /**
   * Skip AGENTS.md/CLAUDE.md discovery (`--no-context-files`). No session
   * sets it, Claude ones included: from pi-claude-cli 0.9.0 the CLI loads no
   * CLAUDE.md of its own, so pi's copy is the only one the model sees. pi only.
   */
  noContextFiles?: boolean
  /** Owned process group: disposal must also stop nested CLI/tools. */
  ownProcessGroup?: boolean
  /** Extra environment variables. */
  env?: Record<string, string>
}

interface PiRpcClientEvents {
  /** Any protocol event from pi stdout (not responses, not extension UI). */
  event: [PiEvent]
  /** Extension UI request needing user interaction or display. */
  'extension-ui': [ExtensionUIRequest]
  /** Raw stderr text (diagnostics). */
  stderr: [string]
  /** Process exited. `expected` is true when we initiated the shutdown. */
  exit: [{ code: number | null; signal: NodeJS.Signals | null; expected: boolean }]
  /** A stdout line failed to parse as JSON (protocol violation / noise). */
  'parse-error': [{ line: string; error: Error }]
  /** omp's startup frame, written before it answers any command. pi sends none. */
  ready: [OmpReadyFrame]
  /** omp's forwarded subagent activity (`omp-dialect.ts`, "Subagents"). pi sends none. */
  subagent: [OmpSubagentFrame]
}

interface PendingRequest {
  resolve: (response: RpcResponse) => void
  reject: (error: Error) => void
  /** Reads the agent's answer back as pi's (omp only; see `omp-dialect.ts`). */
  decode?: (response: RpcResponse) => RpcResponse
}

/**
 * One live pi subprocess speaking the RPC protocol over stdio.
 *
 * - Strict LF JSONL framing via JsonlDecoder (never readline).
 * - Commands carry a generated `id`; responses resolve the matching promise.
 * - Everything without an `id` streams out via the typed event emitter.
 */
export class PiRpcClient extends EventEmitter<PiRpcClientEvents> {
  readonly activity = new SessionActivity()
  private child: ChildProcessWithoutNullStreams | null = null
  private readonly stdoutDecoder = new JsonlDecoder()
  private readonly stderrDecoder = new JsonlDecoder()
  private readonly pending = new Map<string, PendingRequest>()
  private nextRequestId = 1
  private shuttingDown = false
  private killTimer: NodeJS.Timeout | null = null
  /** The agent this process is (see `PiSpawnOptions.agent`). */
  readonly agent: AgentKind
  private startupFrame: OmpReadyFrame | undefined
  /**
   * omp only: every outbound line waits on this until the transport is
   * settled — v2 negotiated, or v1 known to be all there is — so no command
   * goes out whose answer could come back on the wrong framing. pi has no
   * handshake and writes straight through.
   */
  private outbound: Promise<void> = Promise.resolve()
  private openOutbound: (() => void) | null = null
  /** omp only, from the `ready` frame on: reassembles v2 `rpc_chunk` runs. */
  private chunks: OmpChunkDecoder | null = null
  private negotiatedProtocol = 1
  /** omp only: the subagent level omp confirmed, once it answered. */
  private subagentLevel: OmpSubagentSubscriptionLevel | undefined
  private readonly endedTools = new OmpEndedTools()

  constructor(private readonly options: PiSpawnOptions) {
    super()
    this.agent = options.agent ?? 'pi'
    if (this.agent === 'omp') {
      this.outbound = new Promise((resolve) => {
        this.openOutbound = resolve
      })
    }
  }

  /** The stdout framing in use: 2 once omp accepted `negotiate_protocol`, else 1. */
  get protocolVersion(): number {
    return this.negotiatedProtocol
  }

  private learnedSessionFile: string | undefined

  /** omp's `ready` frame once it has arrived; always undefined for pi. */
  get readyFrame(): OmpReadyFrame | undefined {
    return this.startupFrame
  }

  /**
   * The subagent level omp confirmed for this process. Undefined for pi, and
   * for an omp that has not answered yet or refused.
   */
  get subagentSubscription(): OmpSubagentSubscriptionLevel | undefined {
    return this.subagentLevel
  }

  /** Updated before get_state reaches any caller, including routine execution. */
  get sessionFile(): string | undefined {
    return this.learnedSessionFile ?? this.options.sessionPath
  }

  get pid(): number | undefined {
    return this.child?.pid
  }

  get alive(): boolean {
    return this.child !== null && this.child.exitCode === null && !this.child.killed
  }

  spawn(): void {
    if (this.child) throw new Error('PiRpcClient already spawned')

    const o = this.options
    const bin = o.binaryPath ?? this.agent
    const args = this.agent === 'omp' ? ompRpcArgs(o) : piRpcArgs(o)

    const child = spawn(bin, args, {
      cwd: o.cwd,
      env: { ...process.env, ...o.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: o.ownProcessGroup && process.platform !== 'win32',
    })
    this.child = child

    // The exact argv, because reconstructing it once meant shimming the
    // binary on PATH to capture what was really passed. Env is deliberately
    // omitted — it carries API keys.
    log('pi', 'spawn', {
      bin,
      args,
      cwd: o.cwd,
      pid: child.pid,
    })

    child.stdout.on('data', (chunk: Buffer) => {
      for (const line of this.stdoutDecoder.push(chunk)) this.handleLine(line)
    })
    child.stdout.on('end', () => {
      for (const line of this.stdoutDecoder.end()) this.handleLine(line)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      for (const line of this.stderrDecoder.push(chunk)) this.emit('stderr', line)
    })
    // A write to a child whose stdin already closed (EIO/EPIPE) fails its own
    // callback, and the stream also emits 'error'. With no listener, Node
    // raises that as an uncaughtException in main. The callback already
    // rejects the request, and 'exit' fails the rest.
    child.stdin.on('error', (error) => {
      log('pi', 'stdin write failed', { pid: child.pid, message: error.message })
    })

    child.on('exit', (code, signal) => {
      // The group can outlive pi (notably a parked Claude CLI).
      if (o.ownProcessGroup && process.platform !== 'win32') this.signalChild(child, 'SIGKILL')
      if (this.killTimer) {
        clearTimeout(this.killTimer)
        this.killTimer = null
      }
      const expected = this.shuttingDown
      this.failAllPending(new Error(`pi exited (code=${code}, signal=${signal ?? 'none'})`))
      this.emit('exit', { code, signal, expected })
      this.child = null
    })

    child.on('error', (error) => {
      // Spawn failure (e.g. binary vanished): surface as an unexpected exit.
      log('pi', 'spawn failed', { bin, message: error.message })
      this.failAllPending(error)
      this.emit('exit', { code: null, signal: null, expected: false })
      this.child = null
    })
  }

  /**
   * Send a command and await its correlated response.
   * The promise resolves with the response object even when `success` is
   * false — protocol-level errors are data, not exceptions. It rejects only
   * when the transport is broken (process dead, stdin write failed).
   */
  request<T extends RpcCommand['type']>(
    command: Extract<RpcCommand, { type: T }>,
  ): Promise<RpcResponse<RpcResponseDataMap[T]>> {
    const child = this.child
    if (!child || !this.alive) {
      return Promise.reject(new Error('pi process is not running'))
    }
    if (
      shutdownApproval.closing &&
      !command.type.startsWith('get_') &&
      !['abort', 'abort_bash', 'abort_retry', 'clear_queue'].includes(command.type)
    )
      return Promise.reject(new Error('Phosphor is shutting down. New work cannot start.'))
    const id = `px-${this.nextRequestId++}`
    const translated = this.agent === 'omp' ? encodeOmpCommand(command) : null
    const payload = { ...(translated?.wire ?? command), id }

    // Interrupts specifically, not every command: a killed turn used to leave
    // no trace at all. The log recorded the spawn and pi's stderr, so a
    // session that ended mid-work looked identical to one that finished, and
    // the sub-agents killed with it left nothing to correlate against.
    if (command.type === 'abort' || command.type === 'abort_bash') {
      log('pi', command.type, { sessionId: this.options.sessionId, requestId: id })
    }

    return new Promise<RpcResponse<RpcResponseDataMap[T]>>((resolve, reject) => {
      this.activity.requested(id, command.type)
      this.pending.set(id, {
        resolve: resolve as (r: RpcResponse) => void,
        reject,
        ...(translated?.decode ? { decode: translated.decode } : {}),
      })
      this.write(JSON.stringify(payload) + '\n', (error) => {
        if (error) {
          this.pending.delete(id)
          this.activity.failed(id)
          reject(error)
        }
      })
    })
  }

  /** One line to stdin, behind omp's transport handshake (`outbound`). */
  private write(line: string, done: (error?: Error | null) => void): void {
    if (!this.openOutbound) {
      this.child?.stdin.write(line, done)
      return
    }
    void this.outbound.then(() => {
      const child = this.child
      if (!child || !this.alive) {
        done(new Error('pi process is not running'))
        return
      }
      child.stdin.write(line, done)
    })
  }

  /** Release every held line: the framing is settled (or the process is gone). */
  private settleTransport(): void {
    const open = this.openOutbound
    this.openOutbound = null
    if (open && this.agent === 'omp') this.subscribeSubagents()
    open?.()
  }

  /**
   * Ask omp to forward subagent activity, written ahead of the held queue so
   * it is in effect before any prompt can spawn a subagent. Every omp process,
   * a new session or a resumed one, settles its transport exactly once.
   */
  private subscribeSubagents(): void {
    const child = this.child
    if (!child || !this.alive) return
    const id = `px-subagents-${this.nextRequestId++}`
    this.pending.set(id, {
      resolve: (response) => {
        const data: unknown = response.success ? response.data : undefined
        const level = data && typeof data === 'object' && 'level' in data ? data.level : undefined
        if (level === 'off' || level === 'progress' || level === 'events') {
          this.subagentLevel = level
        } else {
          log('pi', 'omp subagent subscription refused', {
            error: response.success ? 'no level in the answer' : response.error,
          })
        }
      },
      // The process went away; there is nothing left to subscribe to.
      reject: () => undefined,
    })
    child.stdin.write(JSON.stringify(ompSubagentSubscriptionCommand(id)) + '\n', (error) => {
      if (error) this.pending.delete(id)
    })
  }

  /**
   * omp's still-running subagents (`get_subagents`), for a view that opens
   * onto a session after they started. Rejects when omp refuses (one that
   * predates the command). pi has none and is never asked.
   */
  getSubagents(): Promise<OmpSubagentSnapshot[]> {
    if (this.agent !== 'omp') return Promise.resolve([])
    if (!this.child || !this.alive) return Promise.reject(new Error('pi process is not running'))
    const id = `px-${this.nextRequestId++}`
    return new Promise((resolve, reject) => {
      this.pending.set(id, {
        resolve: (response) =>
          response.success
            ? resolve(ompSubagentSnapshots(response))
            : reject(new Error(`get_subagents failed: ${response.error}`)),
        reject,
      })
      this.write(JSON.stringify({ id, type: 'get_subagents' }) + '\n', (error) => {
        if (!error) return
        this.pending.delete(id)
        reject(error)
      })
    })
  }

  /**
   * omp's `ready` frame: upgrade to v2 when offered, written ahead of the
   * held queue. A refusal, or no v2 on offer, leaves v1 — the same transport
   * every omp speaks by default.
   */
  private negotiate(frame: OmpReadyFrame): void {
    this.chunks = new OmpChunkDecoder(
      Number.isSafeInteger(frame.maxReassembledFrameBytes) && frame.maxReassembledFrameBytes! > 0
        ? frame.maxReassembledFrameBytes!
        : OMP_DEFAULT_MAX_REASSEMBLED_BYTES,
    )
    const child = this.child
    if (!offersProtocolV2(frame) || !child) {
      this.settleTransport()
      return
    }
    const id = `px-protocol-${this.nextRequestId++}`
    this.pending.set(id, {
      resolve: (response) => {
        if (response.success) this.negotiatedProtocol = OMP_PROTOCOL_V2
        else log('pi', 'omp protocol v2 refused', { error: response.error })
        this.settleTransport()
      },
      reject: () => this.settleTransport(),
    })
    child.stdin.write(JSON.stringify(ompNegotiateCommand(id)) + '\n', (error) => {
      if (!error) return
      this.pending.delete(id)
      this.settleTransport()
    })
  }

  /**
   * A chunk run that broke the spec. The frame it carried is lost and could
   * have answered any outstanding request, so each one is failed with the
   * reason rather than left waiting for an answer that will never come.
   */
  private chunkFailure(error: OmpChunkError, line: string): void {
    log('pi', 'omp chunked frame rejected', { error: error.message })
    this.emit('parse-error', { line: line.slice(0, 200), error })
    const failure = new Error(`omp sent a malformed chunked frame: ${error.message}`)
    for (const [id, pending] of this.pending) {
      this.activity.failed(id)
      pending.reject(failure)
    }
    this.pending.clear()
  }

  /** Reply to an extension UI dialog request. Fire-and-forget. */
  respondToExtensionUI(response: ExtensionUIResponse): void {
    const child = this.child
    if (!child || !this.alive) return
    this.write(JSON.stringify(response) + '\n', (error) => {
      if (!error) this.activity.answered(response.id)
    })
  }

  /**
   * Graceful shutdown: SIGTERM, escalate to SIGKILL after `graceMs`.
   * Resolves when the process has exited.
   */
  async dispose(graceMs = 3000): Promise<void> {
    const child = this.child
    if (!child || child.exitCode !== null) return
    this.shuttingDown = true

    await new Promise<void>((resolve) => {
      // Failed spawns emit error + close, not exit. They are deletable too.
      child.once('close', () => resolve())
      // A failed spawn has no PID. Never signal that handle: on some Node
      // versions it can target the caller's process group instead.
      if (!child.pid) return
      this.signalChild(child, 'SIGTERM')
      this.killTimer = setTimeout(() => {
        if (child.exitCode === null) this.signalChild(child, 'SIGKILL')
      }, graceMs)
      // Don't hold the event loop open just for the escalation timer.
      this.killTimer.unref()
    })
  }

  /**
   * Immediate, synchronous kill for signal-initiated shutdown, where there is
   * no time to await an exit (the parent is already tearing the group down).
   * An unfinished turn may not be persisted. SIGTERM does not guarantee a
   * session flush; this path cannot wait for confirmation.
   */
  killNow(): void {
    const child = this.child
    if (!child || child.exitCode !== null) return
    this.shuttingDown = true
    try {
      this.signalChild(child, 'SIGTERM')
    } catch {
      // already gone
    }
  }

  private signalChild(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
    if (!child.pid) return
    if (!this.options.ownProcessGroup) {
      child.kill(signal)
      return
    }
    if (process.platform === 'win32') {
      // Windows has no POSIX groups. taskkill traverses the owned process tree.
      execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => {
        if (child.exitCode === null) child.kill(signal)
      })
    } else {
      try {
        process.kill(-child.pid, signal)
      } catch {
        /* already gone */
      }
    }
  }

  private handleLine(line: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch (error) {
      this.emit('parse-error', { line, error: error as Error })
      return
    }
    if (typeof parsed !== 'object' || parsed === null) {
      this.emit('parse-error', { line, error: new Error('Non-object JSONL record') })
      return
    }

    // omp v2: an oversized object arrives as a run of `rpc_chunk` lines and
    // is dispatched below as if it had been one line.
    let frame: object = parsed
    if (this.chunks) {
      const result = this.chunks.push(parsed as Record<string, unknown>)
      if (result.error) this.chunkFailure(result.error, line)
      if (result.frame === null) return
      frame = result.frame
    }

    // Consumed here, never forwarded: it is transport handshake, not a
    // session event, and every reader downstream would only drop it.
    if ('type' in frame && frame.type === 'ready') {
      const ready = frame as OmpReadyFrame
      this.startupFrame = ready
      if (this.agent === 'omp') this.negotiate(ready)
      this.emit('ready', ready)
      return
    }
    // An omp that talks before (or without) a ready frame offers no v2.
    if (this.agent === 'omp' && !this.startupFrame) this.settleTransport()

    const translated =
      this.agent === 'omp' ? decodeOmpFrame(frame as Record<string, unknown>) : frame
    if (translated === null) return
    const record = translated as { type?: string; id?: string }
    if (this.agent === 'omp') {
      if (isOmpSubagentFrame(record)) {
        this.emit('subagent', record)
        return
      }
      if (!this.endedTools.admit(record)) return
    }

    if (record.type === 'response') {
      const raw = record as unknown as RpcResponse
      const pending = raw.id ? this.pending.get(raw.id) : undefined
      const response = pending?.decode ? pending.decode(raw) : raw
      this.activity.responded(response)
      if (response.command === 'get_state' && response.success) {
        const state = response.data as RpcResponseDataMap['get_state'] | undefined
        if (state?.sessionFile) this.learnedSessionFile = state.sessionFile
      }
      if (pending) {
        this.pending.delete(response.id!)
        pending.resolve(response)
      }
      // Responses without ids (or unknown ids) have no waiter; drop them.
      return
    }

    if (record.type === 'extension_ui_request') {
      this.activity.dialog(record as unknown as ExtensionUIRequest)
      this.emit('extension-ui', record as unknown as ExtensionUIRequest)
      return
    }

    this.activity.event(record as unknown as PiEvent)
    this.emit('event', record as unknown as PiEvent)
  }

  private failAllPending(error: Error): void {
    for (const [, pending] of this.pending) pending.reject(error)
    this.pending.clear()
    this.activity.exited()
    // Held lines now fail fast with "not running" instead of waiting forever.
    this.settleTransport()
  }
}

/** pi's argv for `--mode rpc`. omp's lives in `omp-dialect.ts`. */
function piRpcArgs(o: PiSpawnOptions): string[] {
  const args = [...(o.prefixArgs ?? []), '--mode', 'rpc']
  if (o.sessionPath) args.push('--session', o.sessionPath)
  if (o.sessionId) args.push('--session-id', o.sessionId)
  if (o.forkFrom) args.push('--fork', o.forkFrom)
  if (o.name) args.push('-n', o.name)
  if (o.model) args.push('--model', o.model)
  if (o.provider) args.push('--provider', o.provider)
  if (o.thinkingLevel) args.push('--thinking', o.thinkingLevel)
  if (o.noSession) args.push('--no-session')
  if (o.noContextFiles) args.push('--no-context-files')
  for (const ext of o.extensions ?? []) args.push('-e', ext)
  if (o.appendSystemPrompt) args.push('--append-system-prompt', o.appendSystemPrompt)
  return args
}
