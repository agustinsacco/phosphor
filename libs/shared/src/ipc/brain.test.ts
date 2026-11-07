import { expectTypeOf, it } from 'vitest'
import type {
  BrainProcessConsent,
  BrainStatus,
  BrainPrefs,
  BrainQuery,
  BrainSearchResult,
  BrainEvidence,
  BrainEvidencePage,
  BrainGraph,
  BrainJob,
  BrainRevision,
  BrainCorrection,
  BrainForgetResult,
} from '../brain'
import type { BrainInvokeMap } from './brain'
import type {
  BrainLearningConsent,
  BrainLearningDetail,
  BrainLearningJobList,
  BrainLearningPreview,
  BrainLearningTarget,
} from '../brain-learning-jobs'

/** UI commands. Authority comes from the Desktop handler, never this DTO. */
export interface BaselineBrainInvokeMap {
  'brain:status': { args: []; result: BrainStatus }
  'brain:setPrefs': { args: [prefs: BrainPrefs]; result: BrainStatus }
  'brain:download': { args: [acceptTerms: boolean]; result: BrainStatus }
  'brain:removeModel': { args: []; result: BrainStatus }
  'brain:search': { args: [query: BrainQuery]; result: BrainSearchResult }
  'brain:read': { args: [evidenceId: string]; result: BrainEvidence }
  'brain:evidence': { args: [scope: string, afterId?: string]; result: BrainEvidencePage }
  'brain:graph': { args: [entityId?: string]; result: BrainGraph }
  'brain:process': { args: [scope: string, consent: BrainProcessConsent]; result: BrainJob }
  'brain:learnPreview': { args: [target: BrainLearningTarget]; result: BrainLearningPreview }
  'brain:learn': {
    args: [target: BrainLearningTarget, consent: BrainLearningConsent]
    result: BrainJob
  }
  'brain:learningJobs': { args: [scope?: string]; result: BrainLearningJobList }
  'brain:learningDetail': { args: [jobId: string]; result: BrainLearningDetail }
  'brain:cancel': { args: [jobId: string]; result: void }
  'brain:review': {
    args: [proposalId: string, approve: boolean, revision: BrainRevision]
    result: void
  }
  'brain:correct': {
    args: [claimId: string, correction: BrainCorrection, revision: BrainRevision]
    result: void
  }
  'brain:forget': { args: [evidenceIds: string[]]; result: BrainForgetResult }
  'brain:transcript': { args: [jobId: string]; result: string }
}

it('freezes the local-only Brain review and retrieval channels', () => {
  expectTypeOf<BrainInvokeMap>().toEqualTypeOf<BaselineBrainInvokeMap>()
})
