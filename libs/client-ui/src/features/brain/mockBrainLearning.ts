import type { BrainJob, BrainStatus } from '@shared/brain'
import type {
  BrainLearningConsent,
  BrainLearningDetail,
  BrainLearningJobList,
  BrainLearningPreview,
  BrainLearningTarget,
} from '@shared/brain-learning-jobs'

/** Browser harness only: fixed synthetic context, no disk, provider or process access. */
export function createMockBrainLearning(state: BrainStatus): {
  preview: (target: BrainLearningTarget) => BrainLearningPreview
  learn: (target: BrainLearningTarget, consent: BrainLearningConsent) => BrainJob
  list: (scope?: string) => BrainLearningJobList
  detail: (id: string) => BrainLearningDetail
} {
  const fingerprints = new Map<string, string>()
  const retries = new Map<string, string>()
  const list = (scope?: string): BrainLearningJobList => {
    const items = state.snapshot.jobs.filter(
      (job) => job.learning && (!scope || job.scope === scope),
    )
    return { items: items.slice(0, 50), truncated: items.length > 50 }
  }
  const preview = (target: BrainLearningTarget): BrainLearningPreview => {
    const { snapshot } = state
    if (
      !snapshot.prefs.enabled ||
      !snapshot.prefs.workspaces.includes(target.workspacePath) ||
      !target.sessionPath
    )
      throw new Error('Enable Brain and enroll this synthetic workspace first.')
    const fingerprint = JSON.stringify([
      target.workspacePath,
      target.sessionPath,
      snapshot.policyEpoch,
    ])
    const previous = snapshot.jobs.find((job) => fingerprints.get(job.id) === fingerprint)
    return {
      target,
      scope: target.workspacePath,
      branch: null,
      graphRevision: snapshot.graphRevision,
      policyEpoch: snapshot.policyEpoch,
      checkpoint: {
        source: {
          sessionId: 'synthetic-source',
          selectedLeafId: 'synthetic-leaf',
          sourceDigest: 'synthetic-source-digest',
          contentDigest: 'synthetic-content-digest',
        },
        sourceEntryCount: 1,
        projectionDigest: 'synthetic-projection',
      },
      binding: {
        provider: 'synthetic-source',
        modelId: 'synthetic-model',
        api: 'synthetic',
        accountId: 'synthetic-slot',
        authMode: 'oauth',
        thinkingLevel: 'off',
        endpoint: 'synthetic-only',
      },
      fingerprint,
      coveredCount: previous?.state === 'completed' ? 1 : 0,
      newCount: previous?.state === 'completed' ? 0 : 1,
      previousJobId: previous?.id ?? null,
      limitations: ['Synthetic browser example only. No real source or provider is read.'],
    }
  }
  const detail = (id: string): BrainLearningDetail => {
    const job = state.snapshot.jobs.find((item) => item.id === id && item.learning)
    if (!job) throw new Error('Private learning job not found.')
    return {
      job,
      outcome: job.learning?.outcome === 'no_findings' ? { type: 'no_findings' } : null,
      proposalId: null,
    }
  }
  return {
    preview,
    list,
    detail,
    learn: (target, consent) =>
      startSynthetic(state, preview(target), consent, fingerprints, retries),
  }
}

function startSynthetic(
  state: BrainStatus,
  preview: BrainLearningPreview,
  consent: BrainLearningConsent,
  fingerprints: Map<string, string>,
  retries: Map<string, string>,
): BrainJob {
  if (consent.policyEpoch !== preview.policyEpoch || consent.fingerprint !== preview.fingerprint)
    throw new Error('Learning consent changed. Refresh preflight.')
  const retryKey = JSON.stringify([preview.fingerprint, consent.retryJobId])
  const repeatedRetry = state.snapshot.jobs.find((job) => job.id === retries.get(retryKey))
  if (consent.retryJobId && repeatedRetry) return repeatedRetry
  const previous = state.snapshot.jobs.find((job) => job.id === preview.previousJobId)
  if (previous && !consent.retryJobId) return previous
  if (consent.retryJobId && (!previous || consent.retryJobId !== previous.id))
    throw new Error('Explicit retry requires the previous synthetic attempt.')
  const job: BrainJob = {
    id: crypto.randomUUID(),
    scope: preview.scope,
    evidenceIds: [],
    model: { provider: preview.binding.provider, id: preview.binding.modelId },
    state: 'completed',
    fence: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    sessionPath: null,
    error: null,
    graphRevision: preview.graphRevision,
    policyEpoch: preview.policyEpoch,
    learning: {
      ...preview.checkpoint,
      target: preview.target,
      branch: preview.branch,
      ...(consent.retryJobId ? { retryOf: consent.retryJobId } : {}),
      binding: preview.binding,
      coveredCount: preview.coveredCount,
      newCount: preview.newCount,
      usage: null,
      outcome: 'no_findings',
    },
  }
  fingerprints.set(job.id, preview.fingerprint)
  if (consent.retryJobId) retries.set(retryKey, job.id)
  state.snapshot.jobs.unshift(job)
  return job
}
