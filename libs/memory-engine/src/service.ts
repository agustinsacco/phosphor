import type { BrainPrefs, BrainSnapshot } from '@phosphor/shared/brain'
import type { MemoryStoreOptions, MemoryStorePort, MemoryVector } from './ports'
import { Data, stable } from './data'
import { Evidence } from './evidence'
import { Jobs } from './jobs'
import { Learning } from './learning'
import { Proposals } from './proposals'
import { Corrections } from './corrections'
import { Retrieval } from './retrieval'
import * as validate from './validation'
import { memorySnapshot as snapshot } from './snapshot'

function preferences(data: Data, evidence: Evidence, prefs: BrainPrefs): BrainSnapshot {
  validate.preferences(prefs)
  if (stable(prefs) === stable(data.prefs())) return snapshot(data)
  data.transaction(() => {
    data.setMeta('prefs', prefs)
    const revision = data.revision()
    data.setMeta('revision', { ...revision, policyEpoch: revision.policyEpoch + 1 })
    for (const job of data.all('jobs')) {
      if (['queued', 'running', 'interrupted'].includes(job.state))
        data.put('jobs', job.id, job.scope, {
          ...job,
          state: 'cancelled',
          fence: job.fence + 1,
          updatedAt: data.now(),
          error: 'Consent changed',
        })
    }
  })
  evidence.expire()
  return snapshot(data)
}
function embeddingItems(
  data: Data,
  modelId: string,
  limit: number,
): { claimId: string; text: string }[] {
  validate.text(modelId, 500)
  validate.check(
    Number.isInteger(limit) && limit > 0 && limit <= 200,
    'Invalid embedding batch limit',
  )
  const scopes = data.prefs().workspaces.filter((scope) => data.enrolled(scope))
  if (!scopes.length) return []
  return data.db
    .prepare(
      `SELECT d.value FROM documents d WHERE d.kind='claims'
    AND d.scope IN (${scopes.map(() => '?').join(',')}) AND json_extract(d.value,'$.state')!='superseded'
    AND NOT EXISTS (SELECT 1 FROM vectors v WHERE v.claim_id=d.id AND v.model_id=?
      AND v.revision=json_extract(d.value,'$.revision')) ORDER BY d.id LIMIT ?`,
    )
    .all(...scopes, modelId, limit)
    .map((row) => {
      const claim = JSON.parse(String(row.value)) as { id: string; summary: string }
      return { claimId: claim.id, text: claim.summary }
    })
}
function putVectors(data: Data, vectors: MemoryVector[]): void {
  validate.bounded(vectors, 8_000_000)
  validate.list(vectors, 200)
  const dimensions = new Map<string, number>()
  for (const vector of vectors) {
    validate.text(vector.claimId)
    validate.text(vector.modelId, 500)
    validate.vector(vector.values)
    const claim = data.require('claims', vector.claimId)
    data.consent(claim.scope)
    validate.check(claim.state !== 'superseded', 'Cannot embed superseded claim')
    const existing =
      dimensions.get(vector.modelId) ??
      data.db.prepare('SELECT value FROM vectors WHERE model_id=? LIMIT 1').get(vector.modelId)
        ?.value
    const size = typeof existing === 'string' ? (JSON.parse(existing) as number[]).length : existing
    validate.check(
      size === undefined || size === vector.values.length,
      'Incompatible model vector dimensions',
    )
    dimensions.set(vector.modelId, vector.values.length)
  }
  data.transaction(() => {
    for (const vector of vectors) {
      const claim = data.require('claims', vector.claimId)
      data.db
        .prepare('INSERT OR REPLACE INTO vectors VALUES (?,?,?,?)')
        .run(claim.id, vector.modelId, claim.revision, JSON.stringify(vector.values))
    }
  })
}
/** Node-only, synchronous store: the Desktop adapter must run this in its database worker. */
export function openMemoryStore(options: MemoryStoreOptions): MemoryStorePort {
  const data = new Data(options)
  try {
    const evidence = new Evidence(data)
    evidence.expire()
    const serve = <T>(fn: () => T): T => {
      evidence.expire()
      return fn()
    }
    const jobs = new Jobs(data, evidence)
    const proposals = new Proposals(data, evidence, jobs)
    const learning = new Learning(data, evidence, jobs, proposals)
    const corrections = new Corrections(data, evidence, proposals)
    const retrieval = new Retrieval(data, evidence)
    return {
      snapshot: () => serve(() => snapshot(data)),
      setPrefs: (prefs) => serve(() => preferences(data, evidence, prefs)),
      capture: (input) => serve(() => evidence.capture(input)),
      read: (id, scopes) => serve(() => evidence.read(id, scopes)),
      evidencePage: (scope, afterId) => serve(() => evidence.evidencePage(scope, afterId)),
      createJob: (scope, model, epoch) => serve(() => jobs.create(scope, model, epoch)),
      learningCoverage: (...args) => serve(() => learning.learningCoverage(...args)),
      createLearning: (input) => serve(() => learning.createLearning(input)),
      completeLearning: (...args) => serve(() => learning.completeLearning(...args)),
      failLearning: (...args) => serve(() => learning.failLearning(...args)),
      learningDetail: (id) => serve(() => learning.learningDetail(id)),
      learningJobs: (scope) => serve(() => learning.learningJobs(scope)),
      claimJob: (id) => serve(() => jobs.claim(id)),
      updateJob: (id, fence, patch) => serve(() => jobs.update(id, fence, patch)),
      job: (id) => serve(() => jobs.get(id)),
      submit: (id, fence, input) => serve(() => proposals.submit(id, fence, input)),
      review: (id, approve, revision) => serve(() => proposals.review(id, approve, revision)),
      correct: (id, correction, revision) =>
        serve(() => corrections.correct(id, correction, revision)),
      forget: (ids) => evidence.forget(ids),
      recordDelivery: (delivery) => serve(() => evidence.delivery(delivery)),
      excludedSource: (id) =>
        serve(() => {
          validate.text(id)
          return evidence.excluded(id)
        }),
      graph: (entityId) => serve(() => retrieval.graph(entityId)),
      search: (query, scopes, vector) => serve(() => retrieval.search(query, scopes, vector)),
      embeddingItems: (modelId, limit) => serve(() => embeddingItems(data, modelId, limit)),
      putVectors: (vectors) => serve(() => putVectors(data, vectors)),
      pendingPurges: () => {
        evidence.expire()
        return evidence.pendingPurges()
      },
      acknowledgePurge: (jobId) => evidence.acknowledgePurge(jobId),
      close: () => data.close(),
    }
  } catch (error) {
    data.close()
    throw error
  }
}
