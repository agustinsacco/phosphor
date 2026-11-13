export interface BrainTraceEvent {
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
export interface BrainForkTrace {
  firstStdoutMs: number | null
  firstMessageStartMs: number | null
  firstMessageUpdateMs: number | null
  agentStarts: number
  turns: number
  messageUpdates: number
  retries: BrainTraceEvent[]
  compactions: BrainTraceEvent[]
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
  reason: 'spawn' | 'exit' | 'timeout' | 'aborted' | 'overflow' | 'completed' | 'error' | 'no-text'
}
/** What happened to one claim or link the model proposed. */
export interface BrainExtractionOutcome {
  /** Window and claim ref in the model's answer, e.g. "w2:c4". */
  candidate: string
  summary: string
  status: 'kept' | 'folded' | 'reconfirms' | 'enriches' | 'held' | 'dropped'
  proposalIndex?: number
  /** Existing memory it confirms or enriches, or the approved memory. */
  memoryId?: string
  /** Why a claim or one of its links was dropped or held, e.g. "quote not found in s4". */
  reason?: string
}
/** One private model call. The prompt is not stored: it is rebuilt from the lane on demand. */
export interface BrainExtractionCall {
  stage: 'extract' | 'identity' | 'parents' | 'reconcile' | 'repair'
  /** Window index for extract calls, batch index otherwise. */
  part: number
  /** Lane entries the call read. */
  entryIds: string[]
  inputHash: string
  /** Scrubbed, bounded answer; truncation is explicitly marked. */
  answer: string
  trace: BrainForkTrace | null
  error: string | null
}
export interface BrainExtractionRecord {
  jobId: string
  sessionId: string
  sessionPath: string
  title: string
  leafId: string | null
  model: string
  thinking: string
  calls: BrainExtractionCall[]
  outcomes: BrainExtractionOutcome[]
  error: string | null
  startedAt: number
  finishedAt: number
}
export interface BrainSourceSegment {
  entryId: string
  role: 'user' | 'assistant' | 'toolResult' | 'context'
  label: string
  observedAt: number
  text: string
}
export interface BrainExtractionView extends BrainExtractionRecord {
  /** Each call's prompt, rebuilt from the lane file; empty when the lane is gone. */
  prompts: string[]
  memories: { id: string; summary: string }[]
  source: {
    sessionPath: string
    title: string
    leafId: string | null
    exists: boolean
    segments: BrainSourceSegment[]
  }
}
