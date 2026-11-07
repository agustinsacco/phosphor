import type { BrainLearningPreview } from '@shared/brain-learning-jobs'
import type { BrainJob } from '@shared/brain'

export const learningPreview: BrainLearningPreview = {
  target: { workspacePath: '/synthetic', sessionPath: '/synthetic/source.jsonl' },
  scope: '/synthetic',
  graphRevision: 3,
  policyEpoch: 2,
  checkpoint: {
    source: {
      sessionId: 'source-session',
      selectedLeafId: 'selected-leaf',
      sourceDigest: 'source-digest',
      contentDigest: 'content-digest',
    },
    sourceEntryCount: 12,
    projectionDigest: 'projected-digest',
  },
  binding: {
    provider: 'source-provider',
    modelId: 'source-model',
    api: 'synthetic',
    accountId: 'configured-slot',
    authMode: 'oauth',
    thinkingLevel: 'high',
    endpoint: 'synthetic-only',
  },
  fingerprint: 'exact-fingerprint',
  coveredCount: 2,
  newCount: 3,
  previousJobId: null,
  limitations: ['Synthetic projection limitation'],
}
export function learningJob(patch: Partial<BrainJob> = {}): BrainJob {
  return {
    id: 'learning-job',
    scope: '/synthetic',
    model: { provider: 'source-provider', id: 'source-model' },
    state: 'running',
    evidenceIds: [],
    fence: 1,
    createdAt: 1,
    updatedAt: 1,
    sessionPath: null,
    error: null,
    policyEpoch: 2,
    graphRevision: 3,
    learning: {
      ...learningPreview.checkpoint,
      target: learningPreview.target,
      binding: learningPreview.binding,
      coveredCount: 2,
      newCount: 3,
      usage: null,
      outcome: null,
    },
    ...patch,
  }
}
