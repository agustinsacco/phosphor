import type { BrainJob, BrainModel } from '@phosphor/shared/brain'
import { basename } from 'node:path'
import { type Data, identifier, stable } from './data'
import * as validate from './validation'
import { manualBatch } from './job-batches'

export class Jobs {
  constructor(readonly data: Data) {}
  get(id: string): BrainJob {
    validate.text(id)
    return this.data.require('jobs', id)
  }
  authorize(job: BrainJob): void {
    this.data.consent(job.scope)
    this.data.assertRevision(job)
    validate.check(
      stable(job.model) === stable(this.data.prefs().processor),
      'Processor consent changed',
    )
    for (const id of job.evidenceIds) {
      validate.check(
        this.data.require('evidence', id).scope === job.scope,
        'Invalid job evidence scope',
      )
    }
  }
  create(scope: string, model: BrainModel, expectedPolicyEpoch?: number): BrainJob {
    validate.check(
      expectedPolicyEpoch === undefined || expectedPolicyEpoch === this.data.revision().policyEpoch,
      'Stale processing consent',
    )
    validate.text(scope)
    validate.model(model)
    this.data.consent(scope)
    validate.check(
      stable(model) === stable(this.data.prefs().processor),
      'Processor requires explicit consent',
    )
    const selection = manualBatch(this.data, scope, model)
    if (selection.active) return selection.active
    const evidenceIds = selection.evidenceIds
    validate.check(
      evidenceIds.length > 0,
      'No eligible evidence; review pending work or capture new sources',
    )
    const revision = this.data.revision()
    const batchId = identifier('job', scope, model, evidenceIds, revision)
    const batch = this.data.db
      .prepare('SELECT attempt,job_id FROM job_batches WHERE id=?')
      .get(batchId)
    const attempt = batch ? Number(batch.attempt) + 1 : 0
    const id = identifier(batchId, attempt)
    const job: BrainJob = {
      id,
      scope,
      evidenceIds,
      model,
      ...revision,
      state: 'queued',
      fence: 0,
      createdAt: this.data.now(),
      updatedAt: this.data.now(),
      sessionPath: null,
      error: null,
    }
    this.data.transaction(() => {
      this.data.put('jobs', id, scope, job)
      this.data.db
        .prepare('INSERT OR REPLACE INTO job_batches VALUES (?,?,?)')
        .run(batchId, attempt, id)
    })
    return job
  }
  claim(id: string): BrainJob {
    return this.data.transaction(() => {
      const job = this.get(id)
      this.authorize(job)
      validate.check(
        ['queued', 'interrupted', 'failed'].includes(job.state),
        'Job cannot be claimed',
      )
      const next: BrainJob = {
        ...job,
        fence: job.fence + 1,
        state: 'running',
        updatedAt: this.data.now(),
        error: null,
      }
      this.data.put('jobs', id, job.scope, next)
      return next
    })
  }
  fenced(id: string, fence: number): BrainJob {
    const job = this.get(id)
    this.authorize(job)
    validate.check(Number.isSafeInteger(fence) && job.fence === fence, 'Stale processor fence')
    return job
  }
  update(
    id: string,
    fence: number,
    patch: Pick<Partial<BrainJob>, 'state' | 'sessionPath' | 'error'>,
  ): BrainJob {
    validate.bounded(patch, 20_000)
    validate.check(patch && typeof patch === 'object', 'Invalid job patch')
    validate.check(
      Object.keys(patch).every((key) => ['state', 'sessionPath', 'error'].includes(key)),
      'Invalid job patch field',
    )
    if (patch.sessionPath !== undefined && patch.sessionPath !== null)
      validate.text(patch.sessionPath)
    if (patch.error !== undefined && patch.error !== null) validate.text(patch.error, 8000, true)
    const job = this.get(id)
    if (patch.sessionPath !== undefined && job.sessionPath !== null) {
      validate.check(patch.sessionPath === job.sessionPath, 'Processor session path is immutable')
    }
    if (patch.state === 'cancelled') {
      validate.check(job.fence === fence, 'Stale processor fence')
    } else this.fenced(id, fence)
    if (patch.state !== undefined) {
      validate.check(
        ['failed', 'cancelled', 'running'].includes(patch.state),
        'Job state is service-owned',
      )
      validate.check(
        job.state === 'running' || (patch.state === 'cancelled' && job.state !== 'proposed'),
        'Invalid job transition',
      )
    }
    const next: BrainJob = { ...job, ...patch, updatedAt: this.data.now() }
    if (patch.state === 'cancelled' || patch.state === 'failed') next.fence += 1
    this.data.transaction(() => {
      if (next.sessionPath) {
        const name = basename(next.sessionPath, '.jsonl')
        for (const sessionId of [name, name.split('_').at(-1)!])
          this.data.tombstone(identifier('processor-session', sessionId))
      }
      this.data.put('jobs', id, job.scope, next)
    })
    return next
  }
}
