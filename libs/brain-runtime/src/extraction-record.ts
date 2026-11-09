import type {
  BrainExtractionRecord,
  BrainExtractionOutcome,
  BrainJob,
} from '@phosphor/shared/brain'
import type { BrainStore, ProposalResult, RawMemory } from '@phosphor/memory-engine/types'
import type { LaneMeta } from './lane'
import { scrubExcerpt } from './secrets'
import { forkThinking, traceDiagnostic, type ForkTrace } from './fork-trace'

/** Scrub the whole answer before bounding UTF-8 bytes, never a partial credential. */
export function extractionAnswer(text: string): string {
  const bytes = Buffer.from(scrubExcerpt(text))
  const limit = 256 * 1024
  if (bytes.length <= limit) return bytes.toString()
  return (
    bytes
      .subarray(0, limit)
      .toString()
      .replace(/\uFFFD$/u, '') + '\n[answer truncated at 256 KB]'
  )
}

/** Answer and candidate text belongs only in the local record, never the diagnostic log. */
export class ExtractionRecord {
  private record: BrainExtractionRecord | undefined
  private parsedCandidates: number[] = []
  private verifiedCandidates: number[] = []
  private readonly startedAt: number
  constructor(
    private readonly job: BrainJob,
    private readonly store: BrainStore,
    private readonly now: () => number,
  ) {
    this.startedAt = now()
  }

  start(lane: LaneMeta, prompt: string): void {
    this.record = {
      jobId: this.job.id,
      sessionId: lane.sessionId,
      sessionPath: this.job.sessionPath,
      title: this.job.title,
      leafId: lane.leafId,
      model: lane.model,
      thinking: forkThinking(lane.thinking),
      prompt,
      answer: '',
      trace: null,
      outcomes: [],
      error: null,
      startedAt: this.store.job(this.job.id)?.startedAt ?? this.startedAt,
      finishedAt: this.now(),
    }
  }
  fork(trace: ForkTrace): void {
    if (!this.record) return
    this.record.trace = trace
  }
  answer(text: string): void {
    if (this.record) this.record.answer = extractionAnswer(text)
  }
  parsed(candidate: number, memory: RawMemory | undefined, summary: string, reason?: string): void {
    if (!this.record) return
    if (memory) this.parsedCandidates.push(candidate)
    this.record.outcomes.push({
      candidate,
      summary: scrubExcerpt(summary).slice(0, 2000),
      status: 'dropped',
      reason: reason ?? (memory ? 'run failed before proposal' : 'invalid shape'),
    })
  }
  verified(index: number, kept: boolean): void {
    const candidate = this.parsedCandidates[index]!
    if (kept) this.verifiedCandidates.push(candidate)
    else {
      const outcome = this.record?.outcomes.find((item) => item.candidate === candidate)
      if (outcome) outcome.reason = 'no verified quote'
    }
  }
  proposed(result: ProposalResult): void {
    if (!this.record) return
    for (const item of result.outcomes) {
      const candidate = this.verifiedCandidates[item.candidate]!
      const index = this.record.outcomes.findIndex((old) => old.candidate === candidate)
      const previous = this.record.outcomes[index]
      const outcome: BrainExtractionOutcome = { ...item, candidate }
      if (previous?.reason === 'link check rewritten') outcome.reason = previous.reason
      this.record.outcomes[index] = outcome
    }
    this.save()
  }
  failed(error: Error): void {
    if (!this.record) return
    this.record.error = traceDiagnostic(error.message)
    this.save()
  }
  private save(): void {
    if (!this.record) return
    this.record.finishedAt = this.now()
    this.store.saveExtraction(this.record)
  }
}
