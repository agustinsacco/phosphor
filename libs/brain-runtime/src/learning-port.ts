import type { BrainLearningTarget } from '@phosphor/shared/brain-learning-jobs'
import type {
  BrainLearningBinding,
  BrainLearningCheckpoint,
  BrainLearningEvidence,
  BrainLearningRequest,
  BrainLearningResult,
} from '@phosphor/shared/brain-learning'

/** Main-process ownership, projection and billing binding. Never a renderer or model port. */
export interface PreparedBrainLearning {
  scope: string
  binding: BrainLearningBinding
  /** Supported selected-model output ceiling, bounded at 32768; never a model fallback. */
  maxOutputTokens: number
  checkpoint: BrainLearningCheckpoint
  evidence: BrainLearningEvidence[]
  /** Exactly one direct-provider request; no agent scheduler or attached executors. */
  run(request: BrainLearningRequest, signal: AbortSignal): Promise<BrainLearningResult>
  /** Close the private process and purge its copied source, including on cancellation. */
  dispose(): Promise<void>
}
export interface BrainLearningHost {
  /** Snapshot and attest only. No inference, credential fallback or mutation of the source. */
  prepare(
    target: BrainLearningTarget,
    jobId: string,
    signal: AbortSignal,
  ): Promise<PreparedBrainLearning>
}
