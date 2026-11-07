import type { BrainJob } from '@phosphor/shared/brain'
import type {
  BrainLearningStoreOperations,
  BrainLearningStart,
  BrainLearningCompletion,
  BrainLearningDetail,
} from '@phosphor/shared/brain-learning-jobs'
import type { BrainLearningUsage } from '@phosphor/shared/brain-learning'
import { type Data, stable } from './data'
import type { Evidence } from './evidence'
import type { Jobs } from './jobs'
import type { Proposals } from './proposals'
import * as validate from './validation'
import * as learningValidate from './learning-validation'
import {
  attemptKey,
  previous,
  receipt,
  requestedCoverage,
  sourceAllowed,
} from './learning-receipts'
import { learningJob, prepareInputs, saveInputs } from './learning-inputs'
import { learningProposal } from './learning-proposals'
import { activeProcessor } from './source-exclusion'

export class Learning implements BrainLearningStoreOperations {
  constructor(
    readonly data: Data,
    readonly evidence: Evidence,
    readonly jobs: Jobs,
    readonly proposals: Proposals,
  ) {}
  learningCoverage(
    scope: string,
    sessionId: string,
    projectionDigest: string,
    contributions: Array<{ rootId: string; projectedHash: string }>,
    dependencyRootIds: string[],
  ) {
    validate.text(projectionDigest, 200)
    sourceAllowed(this.data, scope, sessionId, dependencyRootIds)
    const covered = requestedCoverage(this.data, scope, contributions)
    const job = this.previous(scope, contributions)
    if (job) receipt(this.data, job)
    return { covered, previousJobId: job?.id ?? null }
  }
  private previous(
    scope: string,
    contributions: Array<{ rootId: string; projectedHash: string }>,
  ): BrainJob | undefined {
    const exact = previous(this.data, attemptKey(scope, contributions))
    if (exact) return exact
    let newest: BrainJob | undefined
    for (const item of contributions) {
      const row = this.data.db
        .prepare(
          `SELECT j.value FROM learning_coverage c JOIN documents j ON j.kind='jobs' AND j.id=c.job_id WHERE c.scope=? AND c.root_id=? AND c.projected_hash=? ORDER BY json_extract(j.value,'$.updatedAt') DESC,j.rowid DESC LIMIT 1`,
        )
        .get(scope, item.rootId, item.projectedHash)
      if (!row) continue
      const job = JSON.parse(String(row.value)) as BrainJob
      if (!newest || job.updatedAt >= newest.updatedAt) newest = job
    }
    return newest
  }
  createLearning(input: BrainLearningStart): { job: BrainJob; created: boolean } {
    learningValidate.start(input)
    try {
      return this.data.transaction(() => this.create(input))
    } catch (error) {
      this.evidence.cleanOrphans()
      throw error
    }
  }
  private create(input: BrainLearningStart): { job: BrainJob; created: boolean } {
    const { scope } = input
    sourceAllowed(this.data, scope, input.checkpoint.source.sessionId, input.dependencyRootIds)
    validate.check(
      input.expectedPolicyEpoch === this.data.revision().policyEpoch,
      'Stale learning consent',
    )
    const covered = requestedCoverage(this.data, scope, input.covered)
    const isCovered = (item: { rootId: string; projectedHash: string }) =>
      covered.some((old) => old.rootId === item.rootId && old.projectedHash === item.projectedHash)
    const coveredCount = input.covered.filter(isCovered).length
    const old = previous(this.data, attemptKey(scope, input.covered))
    const previousJob =
      old ?? (input.covered.every(isCovered) ? this.previous(scope, input.covered) : undefined)
    const previousInput = previousJob ? receipt(this.data, previousJob) : undefined
    if (input.retryJobId !== undefined && previousInput?.retryJobId === input.retryJobId) {
      validate.check(
        stable(input.binding) === stable(previousInput.binding),
        'Learning source/model binding mismatch',
      )
      return { job: previousJob!, created: false }
    }
    if (input.retryJobId !== undefined)
      validate.check(
        previousJob?.id === input.retryJobId && !['queued', 'running'].includes(previousJob.state),
        'Explicit retry must match a terminal learning attempt',
      )
    else if (previousJob) {
      validate.check(
        stable(input.binding) === stable(previousInput?.binding),
        'Learning source/model binding mismatch',
      )
      return { job: previousJob, created: false }
    }
    validate.check(!activeProcessor(this.data), 'Another processor job is active')
    validate.check(!this.data.get('jobs', input.jobId), 'Learning owner job ID already exists')
    for (const item of input.evidence)
      validate.check(
        item.eligible === (input.retryJobId !== undefined || !isCovered(item)),
        'Learning coverage eligibility mismatch',
      )
    validate.check(
      input.evidence.some((item) => item.eligible) || input.retryJobId !== undefined,
      'No new eligible learning evidence',
    )
    const prepared = prepareInputs(this.data, input)
    const job = learningJob(this.data, input, prepared.receipt.evidenceIds, coveredCount)
    validate.bounded(job.learning, 16000)
    saveInputs(this.data, this.evidence, prepared.receipt, prepared.sources)
    this.data.put('jobs', job.id, scope, job)
    return { job, created: true }
  }
  completeLearning(
    jobId: string,
    fence: number,
    completion: BrainLearningCompletion,
  ): BrainLearningDetail {
    validate.bounded(completion, 300000)
    learningValidate.usage(completion.usage)
    return this.data.transaction(() => {
      const job = this.jobs.fenced(jobId, fence)
      validate.check(job.learning && job.state === 'running', 'Learning job is not running')
      const input = receipt(this.data, job)
      const proposalInput = learningProposal(completion.outcome, input, this.evidence)
      const proposal = proposalInput ? this.proposals.prepare(job, fence, proposalInput) : null
      if (proposal) this.data.put('proposals', proposal.id, job.scope, proposal)
      const next: BrainJob = {
        ...job,
        state: proposal ? 'proposed' : 'completed',
        updatedAt: this.data.now(),
        learning: { ...job.learning, usage: completion.usage, outcome: completion.outcome.type },
      }
      this.data.put('jobs', jobId, job.scope, next)
      this.data.put('learningResults', jobId, job.scope, {
        outcome: completion.outcome,
        proposalId: proposal?.id ?? null,
      })
      for (const contribution of input.covered)
        this.data.db
          .prepare('INSERT OR IGNORE INTO learning_coverage VALUES (?,?,?,?)')
          .run(job.scope, contribution.rootId, contribution.projectedHash, jobId)
      return { job: next, outcome: completion.outcome, proposalId: proposal?.id ?? null }
    })
  }
  failLearning(
    jobId: string,
    fence: number,
    state: 'failed' | 'cancelled' | 'interrupted',
    error: string,
    usage: BrainLearningUsage | null,
  ): BrainJob {
    validate.text(error, 8000, true)
    validate.check(
      ['failed', 'cancelled', 'interrupted'].includes(state),
      'Invalid learning failure state',
    )
    if (usage !== null) learningValidate.usage(usage)
    return this.data.transaction(() => {
      const job = this.jobs.get(jobId)
      validate.check(
        job.learning && job.fence === fence && ['queued', 'running'].includes(job.state),
        'Stale learning failure fence or state',
      )
      const next: BrainJob = {
        ...job,
        state,
        error,
        fence: job.fence + 1,
        updatedAt: this.data.now(),
        learning: { ...job.learning, usage },
      }
      this.data.put('jobs', jobId, job.scope, next)
      return next
    })
  }
  learningDetail(jobId: string): BrainLearningDetail {
    const job = this.jobs.get(jobId)
    this.data.consent(job.scope)
    validate.check(job.learning, 'Not a learning job')
    const result = this.data.get('learningResults', jobId)
    return { job, outcome: result?.outcome ?? null, proposalId: result?.proposalId ?? null }
  }
  learningJobs(scope?: string) {
    if (scope !== undefined) validate.text(scope)
    const scopes = this.data
      .prefs()
      .workspaces.filter(
        (item) => (scope === undefined || scope === item) && this.data.enrolled(item),
      )
    if (!scopes.length) return { items: [], truncated: false }
    const rows = this.data.db
      .prepare(
        `SELECT value FROM documents WHERE kind='jobs' AND scope IN (${scopes.map(() => '?').join(',')}) AND json_type(value,'$.learning')='object' ORDER BY CASE json_extract(value,'$.state') WHEN 'running' THEN 0 WHEN 'queued' THEN 1 ELSE 2 END,json_extract(value,'$.updatedAt') DESC,rowid DESC LIMIT 201`,
      )
      .all(...scopes)
    const items: BrainJob[] = []
    let bytes = 0,
      truncated = rows.length > 200
    for (const row of rows.slice(0, 200)) {
      const size = Buffer.byteLength(String(row.value))
      if (bytes + size > 500000) {
        truncated = true
        continue
      }
      items.push(JSON.parse(String(row.value)) as BrainJob)
      bytes += size
    }
    return { items, truncated }
  }
}
