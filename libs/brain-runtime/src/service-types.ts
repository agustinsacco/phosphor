import type {
  BrainCorrection,
  BrainEvidence,
  BrainEvidencePage,
  BrainForgetResult,
  BrainGraph,
  BrainJob,
  BrainModel,
  BrainPrefs,
  BrainProcessConsent,
  BrainQuery,
  BrainRevision,
  BrainSearchResult,
  BrainStatus,
} from '@phosphor/shared/brain'
import type { createSessionService } from '@phosphor/session-runtime/pi/session-service'
import type { SessionRegistry, LiveSession } from '@phosphor/session-runtime/pi/session-registry'
import type { SessionPathRuntime } from '@phosphor/session-runtime/pi/session-path-lock'
import type { SessionStartupRuntime } from '@phosphor/session-runtime/pi/session-startup'
import type { BrainEmbeddings } from './embedding/embedding-port'
import type { BrainMemoryClient } from './memory-client'
import type { BrainLearningHost } from './learning-port'
import type {
  BrainLearningConsent,
  BrainLearningDetail,
  BrainLearningJobList,
  BrainLearningPreview,
  BrainLearningTarget,
} from '@phosphor/shared/brain-learning-jobs'

export interface BrainApi {
  status(): Promise<BrainStatus>
  setPrefs(prefs: BrainPrefs): Promise<BrainStatus>
  download(acceptTerms: boolean): Promise<BrainStatus>
  removeModel(): Promise<BrainStatus>
  search(query: BrainQuery): Promise<BrainSearchResult>
  read(evidenceId: string): Promise<BrainEvidence>
  evidence(scope: string, afterId?: string): Promise<BrainEvidencePage>
  graph(entityId?: string): Promise<BrainGraph>
  process(scope: string, consent: BrainProcessConsent): Promise<BrainJob>
  learnPreview(target: BrainLearningTarget): Promise<BrainLearningPreview>
  learn(target: BrainLearningTarget, consent: BrainLearningConsent): Promise<BrainJob>
  learningJobs(scope?: string): Promise<BrainLearningJobList>
  learningDetail(jobId: string): Promise<BrainLearningDetail>
  cancel(jobId: string): Promise<void>
  review(proposalId: string, approve: boolean, revision: BrainRevision): Promise<void>
  correct(claimId: string, correction: BrainCorrection, revision: BrainRevision): Promise<void>
  forget(evidenceIds: string[]): Promise<BrainForgetResult>
  transcript(jobId: string): Promise<string>
}
export interface BrainServiceOptions {
  directory: string
  openStore(directory: string): BrainMemoryClient
  embeddings: BrainEmbeddings
  resources: { workingExtension: string; processorExtension: string }
  sessions: Pick<ReturnType<typeof createSessionService<undefined>>, 'create' | 'disposeBrain'>
  registry: Pick<SessionRegistry, 'get' | 'list' | 'on' | 'off'>
  sessionPaths: SessionPathRuntime
  processor: {
    resolve(model: BrainModel): Promise<{
      binaryPath: string
      prefixArgs?: string[]
      version: string
      env: Record<string, string>
    }>
    /** Audited nonce/job-bound extension handshake; must fail closed. No inference. */
    verifyTools(live: LiveSession): Promise<void>
  }
  /** Trusted local binding; absent adapters refuse selective learning. */
  learningHost?: BrainLearningHost
  onError?: (error: unknown) => void
}
export interface BrainService {
  api: BrainApi
  memory: NonNullable<SessionStartupRuntime['memory']>
  dispose(): Promise<void>
}
