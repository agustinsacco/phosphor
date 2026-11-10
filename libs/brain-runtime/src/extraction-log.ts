import type { BrainJob } from '@phosphor/shared/brain'
import type { BrainServiceOptions } from './types'
import type { ForkTrace } from './fork-trace'
import { traceDiagnostic } from './fork-trace'

/** One job context follows failures through preparation, fork and local processing. */
export class ExtractionLog {
  phase = 'lane'
  model: string
  thinking: string | null = null
  laneBytes: number | null = null
  trace: ForkTrace | null = null
  diagnostic: string | undefined
  private readonly started: number
  private readonly now: () => number

  constructor(
    private readonly job: BrainJob,
    private readonly options: BrainServiceOptions,
  ) {
    this.model = job.model
    this.now = options.now ?? Date.now
    this.started = this.now()
  }

  step(message: string, data: Record<string, unknown> = {}): void {
    this.options.log?.(message, {
      jobId: this.job.id,
      model: this.model,
      thinking: this.thinking,
      laneBytes: this.laneBytes,
      phase: this.phase,
      trace: this.trace,
      totalMs: this.now() - this.started,
      ...data,
    })
  }

  failed(error: unknown, signal: AbortSignal): Error {
    const message = signal.aborted
      ? 'Knowledge extraction aborted.'
      : traceDiagnostic(error instanceof Error ? error.message : 'Knowledge extraction failed.')
    this.step('Brain extraction failed', {
      error: message,
      reason: signal.aborted ? 'aborted' : this.trace?.reason === 'timeout' ? 'timeout' : 'error',
      ...(this.diagnostic ? { stderr: this.diagnostic } : {}),
    })
    return new Error(message)
  }
}
