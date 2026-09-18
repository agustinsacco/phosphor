import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { JsonlDecoder } from './jsonl'
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
  /** Workspace folder — becomes pi's cwd. */
  cwd: string
  /** pi binary; defaults to "pi" resolved via PATH. */
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
  /** Fixed session id (`--session-id`). */
  sessionId?: string
  /** Display name (`-n`). */
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
   * Skip AGENTS.md/CLAUDE.md discovery (`--no-context-files`). Set for
   * Claude-provider sessions, where the Claude CLI loads CLAUDE.md itself
   * and pi's copy would bill the same file twice on every request.
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
}

interface PendingRequest {
  resolve: (response: RpcResponse) => void
  reject: (error: Error) => void
}

/**
 * One live pi subprocess speaking the RPC protocol over stdio.
 *
 * - Strict LF JSONL framing via JsonlDecoder (never readline).
 * - Commands carry a generated `id`; responses resolve the matching promise.
 * - Everything without an `id` streams out via the typed event emitter.
 */
export class PiRpcClient extends EventEmitter<PiRpcClientEvents> {
  private child: ChildProcessWithoutNullStreams | null = null
  private readonly stdoutDecoder = new JsonlDecoder()
  private readonly stderrDecoder = new JsonlDecoder()
  private readonly pending = new Map<string, PendingRequest>()
  private nextRequestId = 1
  private shuttingDown = false
  private killTimer: NodeJS.Timeout | null = null

  constructor(private readonly options: PiSpawnOptions) {
    super()
  }

  private learnedSessionFile: string | undefined

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

    const child = spawn(o.binaryPath ?? 'pi', args, {
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
      bin: o.binaryPath ?? 'pi',
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
      log('pi', 'spawn failed', { bin: o.binaryPath ?? 'pi', message: error.message })
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
    const id = `px-${this.nextRequestId++}`
    const payload = { ...command, id }

    // Interrupts specifically, not every command: a killed turn used to leave
    // no trace at all. The log recorded the spawn and pi's stderr, so a
    // session that ended mid-work looked identical to one that finished, and
    // the sub-agents killed with it left nothing to correlate against.
    if (command.type === 'abort' || command.type === 'abort_bash') {
      log('pi', command.type, { sessionId: this.options.sessionId, requestId: id })
    }

    return new Promise<RpcResponse<RpcResponseDataMap[T]>>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (r: RpcResponse) => void, reject })
      child.stdin.write(JSON.stringify(payload) + '\n', (error) => {
        if (error) {
          this.pending.delete(id)
          reject(error)
        }
      })
    })
  }

  /** Reply to an extension UI dialog request. Fire-and-forget. */
  respondToExtensionUI(response: ExtensionUIResponse): void {
    const child = this.child
    if (!child || !this.alive) return
    child.stdin.write(JSON.stringify(response) + '\n')
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
   * SIGTERM lets pi flush its session file; the process is about to die
   * anyway, so nothing waits for confirmation.
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

    const record = parsed as { type?: string; id?: string }

    if (record.type === 'response') {
      const response = record as unknown as RpcResponse
      if (response.command === 'get_state' && response.success) {
        const state = response.data as RpcResponseDataMap['get_state'] | undefined
        if (state?.sessionFile) this.learnedSessionFile = state.sessionFile
      }
      if (response.id && this.pending.has(response.id)) {
        const pending = this.pending.get(response.id)!
        this.pending.delete(response.id)
        pending.resolve(response)
      }
      // Responses without ids (or unknown ids) have no waiter; drop them.
      return
    }

    if (record.type === 'extension_ui_request') {
      this.emit('extension-ui', record as unknown as ExtensionUIRequest)
      return
    }

    this.emit('event', record as unknown as PiEvent)
  }

  private failAllPending(error: Error): void {
    for (const [, pending] of this.pending) pending.reject(error)
    this.pending.clear()
  }
}
