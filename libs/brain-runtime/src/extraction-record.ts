import type {
  BrainExtractionRecord,
  BrainExtractionCall,
  BrainExtractionOutcome,
  BrainJob,
} from '@phosphor/shared/brain'
import type { BrainStore } from '@phosphor/memory-engine/types'
import { scrubExcerpt } from './secrets'
import { ANSWER_BYTES } from './constants'
import { traceDiagnostic } from './call-trace'

export function extractionAnswer(text: string): string {
  const bytes = Buffer.from(scrubExcerpt(text))
  if (bytes.length <= ANSWER_BYTES) return bytes.toString()
  return (
    bytes
      .subarray(0, ANSWER_BYTES)
      .toString()
      .replace(/\uFFFD$/u, '') + '\n[answer truncated at 64 KB]'
  )
}
export class ExtractionRecord {
  readonly record: BrainExtractionRecord
  constructor(
    job: BrainJob,
    private readonly store: BrainStore,
    private readonly now: () => number,
    thinking: string,
  ) {
    const previous = (() => {
      try {
        return store.extraction(job.id)
      } catch {
        return undefined
      }
    })()
    this.record = {
      jobId: job.id,
      sessionId: job.sessionId,
      sessionPath: job.sessionPath,
      title: job.title,
      leafId: job.leafId,
      model: job.model,
      thinking,
      calls: previous?.calls ?? [],
      outcomes: [],
      error: null,
      startedAt: job.startedAt ?? now(),
      finishedAt: now(),
    }
  }
  call(call: BrainExtractionCall): void {
    this.record.calls.push({ ...call, answer: extractionAnswer(call.answer) })
    this.save()
  }
  outcomes(outcomes: BrainExtractionOutcome[]): void {
    this.record.outcomes = outcomes
    this.save()
  }
  failed(error: unknown): void {
    this.record.error = traceDiagnostic(error instanceof Error ? error.message : String(error))
    this.save()
  }
  save(): void {
    this.record.finishedAt = this.now()
    this.store.saveExtraction(this.record)
  }
}
