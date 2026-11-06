import type { DatabaseSync } from 'node:sqlite'
import type {
  BrainCapture,
  BrainClaim,
  BrainCorrection,
  BrainDelivery,
  BrainEvidence,
  BrainForgetResult,
  BrainGraph,
  BrainJob,
  BrainModel,
  BrainPrefs,
  BrainProposal,
  BrainProposalInput,
  BrainQuery,
  BrainRevision,
  BrainSearchResult,
  BrainSnapshot,
} from '@phosphor/shared/brain'

export interface MemoryStoreOptions {
  directory: string
  Database: typeof DatabaseSync
  now?: () => number
}
export interface MemoryVector {
  claimId: string
  modelId: string
  values: number[]
}
/** Synchronous operations run only in the database worker. */
export interface MemoryStorePort {
  snapshot(): BrainSnapshot
  setPrefs(prefs: BrainPrefs): BrainSnapshot
  capture(input: BrainCapture): BrainEvidence | null
  read(evidenceId: string, allowedScopes: string[]): BrainEvidence
  /** Manual callers must pass the acknowledged epoch; checked in the same worker operation. */
  createJob(scope: string, model: BrainModel, expectedPolicyEpoch?: number): BrainJob
  claimJob(jobId: string): BrainJob
  updateJob(
    jobId: string,
    fence: number,
    patch: Pick<Partial<BrainJob>, 'state' | 'sessionPath' | 'error'>,
  ): BrainJob
  job(jobId: string): BrainJob
  submit(jobId: string, fence: number, input: BrainProposalInput): BrainProposal
  review(proposalId: string, approve: boolean, revision: BrainRevision): void
  correct(claimId: string, correction: BrainCorrection, revision: BrainRevision): BrainClaim
  forget(evidenceIds: string[]): BrainForgetResult
  recordDelivery(delivery: BrainDelivery): void
  graph(entityId?: string): BrainGraph
  search(
    query: BrainQuery,
    allowedScopes: string[],
    vector?: { modelId: string; values: number[] },
  ): BrainSearchResult
  embeddingItems(modelId: string, limit: number): { claimId: string; text: string }[]
  putVectors(vectors: MemoryVector[]): void
  pendingPurges(): { jobId: string; sessionPath: string }[]
  acknowledgePurge(jobId: string): void
  close(): void
}
/** Structured-clone-safe worker port; no SQL or file paths from agent/UI callers. */
export type MemoryClient = {
  [K in keyof MemoryStorePort]: (
    ...args: Parameters<MemoryStorePort[K]>
  ) => Promise<ReturnType<MemoryStorePort[K]>>
}
