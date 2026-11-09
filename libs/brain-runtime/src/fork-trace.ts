import type { PrintModeFailure } from '@phosphor/session-runtime/pi/print-mode'
import { scrubExcerpt } from './secrets'

export const FORK_TIMEOUT_MS = 300_000
export const FORK_STDERR_BYTES = 4096

export interface AssistantMessage {
  role?: string
  stopReason?: string
  errorMessage?: string
  content?: { type: string; text?: string }[]
  usage?: {
    input?: number
    output?: number
    cacheRead?: number
    cacheWrite?: number
    totalTokens?: number
    cost?: { total?: number }
  }
}
export interface ForkEvent {
  type?: string
  message?: AssistantMessage
  usage?: AssistantMessage['usage']
  attempt?: number
  delayMs?: number
  errorMessage?: string
  finalError?: string
  success?: boolean
  reason?: string
  aborted?: boolean
  willRetry?: boolean
  source?: string
}
interface TraceEvent {
  type: string
  atMs: number
  source?: string
  attempt?: number
  delayMs?: number
  errorMessage?: string
  success?: boolean
  reason?: string
  aborted?: boolean
  willRetry?: boolean
}
export interface ForkTrace {
  firstStdoutMs: number | null
  firstMessageStartMs: number | null
  firstMessageUpdateMs: number | null
  agentStarts: number
  turns: number
  messageUpdates: number
  retries: TraceEvent[]
  compactions: TraceEvent[]
  stopReason: string | null
  usage: {
    tokens: number
    cost: number
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
  }
  providerError?: string
  totalMs: number
  reason: PrintModeFailure | 'completed' | 'error' | 'no-text'
}

/** Scrub before clipping so truncation cannot expose part of a credential. */
export function traceDiagnostic(text: string): string {
  return scrubExcerpt(text).slice(0, 600)
}

function numeric(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}
export function assistantUsage(
  usage?: AssistantMessage['usage'],
): Pick<ForkTrace['usage'], 'tokens' | 'cost'> {
  return { tokens: numeric(usage?.totalTokens), cost: numeric(usage?.cost?.total) }
}
function traceUsage(usage?: AssistantMessage['usage']): ForkTrace['usage'] {
  return {
    ...assistantUsage(usage),
    input: numeric(usage?.input),
    output: numeric(usage?.output),
    cacheRead: numeric(usage?.cacheRead),
    cacheWrite: numeric(usage?.cacheWrite),
  }
}
export function forkThinking(thinking: string): string {
  return ['off', 'minimal', 'low'].includes(thinking) ? thinking : 'low'
}

/** Only explicitly selected metadata enters the trace, never message bodies or deltas. */
export class ForkTracer {
  readonly trace: ForkTrace = {
    firstStdoutMs: null,
    firstMessageStartMs: null,
    firstMessageUpdateMs: null,
    agentStarts: 0,
    turns: 0,
    messageUpdates: 0,
    retries: [],
    compactions: [],
    stopReason: null,
    usage: traceUsage(),
    totalMs: 0,
    reason: 'error',
  }
  private readonly started: number
  private retryError: string | undefined

  constructor(private readonly now: () => number = () => performance.now()) {
    this.started = now()
  }

  stdout(): void {
    this.trace.firstStdoutMs ??= this.now() - this.started
  }

  event(event: ForkEvent): void {
    const atMs = this.now() - this.started
    const trace = this.trace
    if (event.type === 'agent_start') trace.agentStarts++
    if (event.type === 'turn_start') trace.turns++
    if (event.type === 'message_start' && event.message?.role === 'assistant')
      trace.firstMessageStartMs ??= atMs
    if (event.type === 'message_update') {
      trace.firstMessageUpdateMs ??= atMs
      trace.messageUpdates++
      if (event.usage) trace.usage = traceUsage(event.usage)
    }
    if (event.type === 'message_end' && event.message?.role === 'assistant') {
      const message = event.message
      trace.stopReason = ['stop', 'length', 'toolUse', 'error', 'aborted'].includes(
        message.stopReason ?? '',
      )
        ? message.stopReason!
        : null
      trace.usage = traceUsage(message.usage)
      trace.providerError =
        typeof message.errorMessage === 'string' ? traceDiagnostic(message.errorMessage) : undefined
    }
    this.lifecycle(event, atMs)
  }

  private lifecycle(event: ForkEvent, atMs: number): void {
    if (
      [
        'auto_retry_start',
        'auto_retry_end',
        'summarization_retry_scheduled',
        'summarization_retry_attempt_start',
        'summarization_retry_finished',
      ].includes(event.type ?? '')
    ) {
      const error = event.errorMessage ?? event.finalError
      const entry: TraceEvent = { type: event.type!, atMs }
      if (typeof event.attempt === 'number') entry.attempt = numeric(event.attempt)
      if (typeof event.delayMs === 'number') entry.delayMs = numeric(event.delayMs)
      if (typeof event.success === 'boolean') entry.success = event.success
      if (typeof error === 'string') entry.errorMessage = traceDiagnostic(error)
      if (event.source === 'compaction' || event.source === 'branchSummary')
        entry.source = event.source
      if (['manual', 'threshold', 'overflow'].includes(event.reason ?? ''))
        entry.reason = event.reason
      this.trace.retries.push(entry)
      if (event.type === 'auto_retry_end' || event.type === 'summarization_retry_finished')
        this.retryError = undefined
      else this.retryError = entry.errorMessage ?? this.retryError ?? 'provider retry'
    }
    if (event.type === 'compaction_start' || event.type === 'compaction_end') {
      const entry: TraceEvent = { type: event.type, atMs }
      if (['manual', 'threshold', 'overflow'].includes(event.reason ?? ''))
        entry.reason = event.reason
      if (typeof event.aborted === 'boolean') entry.aborted = event.aborted
      if (typeof event.willRetry === 'boolean') entry.willRetry = event.willRetry
      if (typeof event.errorMessage === 'string')
        entry.errorMessage = traceDiagnostic(event.errorMessage)
      this.trace.compactions.push(entry)
    }
  }

  timeoutMessage(model: string): string {
    const progress =
      this.retryError !== undefined
        ? `retrying: ${this.retryError}`
        : this.trace.firstMessageUpdateMs === null
          ? 'no reply yet'
          : 'reply started'
    return `Timed out after ${FORK_TIMEOUT_MS / 1000} s waiting for ${model} (${progress})`
  }

  finish(reason: ForkTrace['reason']): void {
    this.trace.reason = reason
    this.trace.totalMs = this.now() - this.started
  }
}
