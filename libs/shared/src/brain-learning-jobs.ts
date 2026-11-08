import type { BrainJob, BrainRevision } from './brain'
import type {
  BrainLearningBinding,
  BrainLearningCheckpoint,
  BrainLearningCoverage,
  BrainLearningEvidence,
  BrainLearningEntry,
  BrainLearningResult,
  BrainLearningSource,
  BrainLearningUsage,
} from './brain-learning'

export interface BrainLearningTarget {
  workspacePath: string
  sessionPath: string
}
/** Compact durable identity; the full copied transcript is private, temporary input. */
export interface BrainLearningCheckpointSummary {
  source: Omit<BrainLearningSource, 'entries'>
  sourceEntryCount: number
  projectionDigest: string
}
export interface BrainLearningJobMetadata extends BrainLearningCheckpointSummary {
  target: BrainLearningTarget
  branch: string | null
  binding: BrainLearningBinding
  /** Explicitly acknowledged predecessor; repeat acknowledgments reuse their successor. */
  retryOf?: string
  coveredCount: number
  newCount: number
  usage: BrainLearningUsage | null
  outcome: 'findings' | 'no_findings' | null
}
export interface BrainLearningPreview extends BrainRevision {
  target: BrainLearningTarget
  scope: string
  branch: string | null
  checkpoint: BrainLearningCheckpointSummary
  binding: BrainLearningBinding
  /** Hash of the verified source, selected billing slot and current consent epoch. */
  fingerprint: string
  coveredCount: number
  newCount: number
  previousJobId: string | null
  limitations: string[]
}
export interface BrainLearningConsent {
  policyEpoch: number
  fingerprint: string
  /** Explicit paid retry/reprocessing, never an automatic reaction to stale review. */
  retryJobId?: string
}
export interface BrainLearningJobList {
  items: BrainJob[]
  truncated: boolean
  /** Shell metadata may be read without constructing an empty Brain store. */
  policy?: { enabled: boolean; workspaces: string[]; policyEpoch: number }
}
export interface BrainLearningDetail {
  job: BrainJob
  outcome: BrainLearningResult['outcome'] | null
  proposalId: string | null
}
/** Trusted backend input, never accepted as a renderer-supplied evidence packet. */
export interface BrainLearningStart {
  jobId: string
  scope: string
  branch: string | null
  target: BrainLearningTarget
  binding: BrainLearningBinding
  checkpoint: BrainLearningCheckpointSummary
  covered: BrainLearningCoverage[]
  dependencyRootIds: string[]
  /** Frozen original-input descriptors, including nontext inputs; never extra witnesses. */
  dependencies: BrainLearningEntry[]
  evidence: BrainLearningEvidence[]
  expectedPolicyEpoch: number
  retryJobId?: string
}
export interface BrainLearningCompletion {
  outcome: BrainLearningResult['outcome']
  usage: BrainLearningUsage
}
/** Storage coverage records survive review rejection; failures never add one. */
export interface BrainLearningCoverageState {
  covered: Array<Pick<BrainLearningCoverage, 'rootId' | 'projectedHash'>>
  previousJobId: string | null
}
/** Synchronous database-worker operations. Learning inputs are backend-owned. */
export interface BrainLearningStoreOperations {
  learningCoverage(
    scope: string,
    sessionId: string,
    projectionDigest: string,
    contributions: Array<Pick<BrainLearningCoverage, 'rootId' | 'projectedHash'>>,
    dependencyRootIds: string[],
  ): BrainLearningCoverageState
  createLearning(input: BrainLearningStart): { job: BrainJob; created: boolean }
  completeLearning(
    jobId: string,
    fence: number,
    completion: BrainLearningCompletion,
  ): BrainLearningDetail
  failLearning(
    jobId: string,
    fence: number,
    state: 'failed' | 'cancelled' | 'interrupted',
    error: string,
    usage: BrainLearningUsage | null,
  ): BrainJob
  learningDetail(jobId: string): BrainLearningDetail
  learningJobs(scope?: string): BrainLearningJobList
}
export function learningCheckpointSummary(
  checkpoint: BrainLearningCheckpoint,
): BrainLearningCheckpointSummary {
  const { entries, ...source } = checkpoint.source
  return { source, sourceEntryCount: entries.length, projectionDigest: checkpoint.projectionDigest }
}
