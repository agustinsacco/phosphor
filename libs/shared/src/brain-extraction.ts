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
export interface BrainExtractionOutcome {
  /** Index in the agent's answer, before validation and deduplication. */
  candidate: number
  summary: string
  status: 'kept' | 'reconfirms' | 'duplicate' | 'dropped'
  proposalIndex?: number
  /** Existing memory for a reconfirmation, or the approved kept memory. */
  memoryId?: string
  /** Earlier proposal index for a duplicate within this answer. */
  duplicateOf?: number
  reason?: string
}
export interface BrainExtractionRecord {
  jobId: string
  sessionId: string
  sessionPath: string
  title: string
  leafId: string | null
  model: string
  thinking: string
  prompt: string
  /** Scrubbed, bounded raw final answer; truncation is explicitly marked. */
  answer: string
  trace: BrainForkTrace | null
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
  memories: { id: string; summary: string }[]
  source: {
    sessionPath: string
    title: string
    leafId: string | null
    exists: boolean
    segments: BrainSourceSegment[]
  }
}
