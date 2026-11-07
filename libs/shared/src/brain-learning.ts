import type { BrainEpistemicKind } from './brain'
import type { ThinkingLevel } from './rpc'

/** Private learning contract; not a public IPC channel or an ordinary Brain processor. */
export const BRAIN_LEARNING_PROTOCOL = 1
export interface BrainLearningBinding {
  provider: string
  modelId: string
  api: string
  /** Opaque host-owned billing slot; never credentials. */
  accountId: string
  authMode: 'oauth' | 'api-key' | 'cli'
  thinkingLevel: ThinkingLevel
  endpoint: string
}
export interface BrainLearningEntry {
  entryId: string
  parentId: string | null
  entryHash: string
  /** SHA-256 of the entry without parentId; survives pi's label re-chaining on forks. */
  rootId: string
}
export interface BrainLearningSource {
  sessionId: string
  selectedLeafId: string
  sourceDigest: string
  /** Selected ancestry only, excluding header identity and unrelated branches. */
  contentDigest: string
  entries: BrainLearningEntry[]
}
export interface BrainLearningCoverage extends BrainLearningEntry {
  projectedHash: string
}
export interface BrainLearningCheckpoint {
  source: BrainLearningSource
  projectionDigest: string
  covered: BrainLearningCoverage[]
}
export interface BrainLearningRequest {
  version: 1
  jobId: string
  source: BrainLearningSource
  binding: BrainLearningBinding
  /** Previously completed projected contributions, including copied roots. */
  alreadyCovered: Array<{ rootId: string; projectedHash: string }>
  suffixTimestamp: number
  maxOutputTokens: number
  deadlineMs: number
}
export interface BrainLearningCitation {
  role: 'user' | 'assistant' | 'toolResult'
  quote: string
}
export interface BrainLearningFinding {
  summary: string
  kind: BrainEpistemicKind
  citations: BrainLearningCitation[]
}
export interface BrainLearningEvidence extends BrainLearningCoverage {
  evidenceId: string
  role: BrainLearningCitation['role']
  text: string
  /** Summaries are evidence of the summary, never of omitted raw entries. */
  sourceType: string
  eligible: boolean
}
export interface BrainLearningUsage {
  input: number | null
  output: number | null
  cacheRead: number | null
  cacheWrite: number | null
  /** Already included in output when known. */
  reasoning: number | null
}
export interface BrainLearningResult {
  version: 1
  jobId: string
  binding: BrainLearningBinding
  checkpoint: BrainLearningCheckpoint
  outcome:
    | { type: 'no_findings' }
    | {
        type: 'findings'
        findings: Array<
          Omit<BrainLearningFinding, 'citations'> & {
            citations: Array<{ evidenceId: string; quote: string }>
          }
        >
      }
  evidence: BrainLearningEvidence[]
  usage: BrainLearningUsage
  execution: {
    logicalGenerations: 1
    /** Vendor-internal attempts are not observable. */
    networkAttempts: null
    serializedPrefixIdentical: false
    cacheReuse: 'best-effort'
    history: 'pi-projected-context'
  }
}
