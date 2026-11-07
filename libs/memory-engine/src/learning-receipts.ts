import type { BrainJob } from '@phosphor/shared/brain'
import type { BrainLearningEvidence, BrainLearningResult } from '@phosphor/shared/brain-learning'
import type { BrainLearningStart } from '@phosphor/shared/brain-learning-jobs'
import { type Data, identifier, stable } from './data'
import { excludedSource } from './source-exclusion'
import * as validate from './validation'
import { assertDependencies } from './learning-dependencies'

export interface LearningInputMap extends Omit<BrainLearningEvidence, 'text'> {
  chunks: Array<{ id: string; metadataHash: string }>
}
export interface LearningReceipt extends Omit<BrainLearningStart, 'evidence'> {
  evidence: LearningInputMap[]
  evidenceIds: string[]
  attemptKey: string
}
export interface LearningResultReceipt {
  outcome: BrainLearningResult['outcome']
  proposalId: string | null
}
export function attemptKey(
  scope: string,
  contributions: Array<{ rootId: string; projectedHash: string }>,
): string {
  return identifier(
    'learning-attempt',
    scope,
    [...new Set(contributions.map((item) => stable([item.rootId, item.projectedHash])))].sort(),
  )
}
export function sourceAllowed(data: Data, scope: string, sessionId: string, roots: string[]): void {
  validate.text(scope)
  validate.text(sessionId, 200)
  validate.strings(roots, 1000)
  validate.check(roots.length > 0, 'Learning source needs dependency roots')
  data.consent(scope)
  validate.check(
    !excludedSource(data, sessionId),
    'Learning source is a memory recipient or processor',
  )
  for (const root of roots)
    validate.check(
      !data.tombstoned(identifier('root', scope, root)) &&
        !data.tombstoned(identifier('evidence', scope, sessionId, root)),
      'Learning source was forgotten',
    )
}
export function receipt(data: Data, job: BrainJob): LearningReceipt {
  const stored = data.require('learningInputs', job.id)
  validate.check(
    identifier(stored.value) === stored.hash,
    'Learning source receipt integrity failure',
  )
  const input = stored.value
  assertDependencies(data, input)
  validate.check(
    job.learning &&
      input.jobId === job.id &&
      input.scope === job.scope &&
      stable(job.learning.binding) === stable(input.binding) &&
      stable(job.learning.source) === stable(input.checkpoint.source) &&
      stable(job.learning.target) === stable(input.target) &&
      job.learning.branch === input.branch &&
      job.learning.retryOf === input.retryJobId &&
      job.learning.projectionDigest === input.checkpoint.projectionDigest &&
      job.learning.sourceEntryCount === input.checkpoint.sourceEntryCount &&
      stable(job.evidenceIds) === stable(input.evidenceIds) &&
      job.model.provider === input.binding.provider &&
      job.model.id === input.binding.modelId &&
      job.policyEpoch === input.expectedPolicyEpoch,
    'Learning source/model binding mismatch',
  )
  for (const item of input.evidence)
    for (const chunk of item.chunks)
      validate.check(
        identifier(data.require('evidence', chunk.id)) === chunk.metadataHash,
        'Learning source metadata receipt integrity failure',
      )
  if (job.learning?.outcome !== null) {
    const result = data.require('learningResults', job.id)
    validate.check(
      result.outcome.type === job.learning?.outcome,
      'Learning result receipt integrity failure',
    )
    if (result.outcome.type === 'findings') {
      const proposal = result.proposalId ? data.require('proposals', result.proposalId) : undefined
      validate.check(
        proposal?.jobId === job.id && proposal.scope === job.scope,
        'Learning proposal receipt integrity failure',
      )
    } else validate.check(result.proposalId === null, 'Unexpected no_findings proposal')
  }
  sourceAllowed(data, job.scope, input.checkpoint.source.sessionId, input.dependencyRootIds)
  return input
}
export function requestedCoverage(
  data: Data,
  scope: string,
  contributions: Array<{ rootId: string; projectedHash: string }>,
): Array<{ rootId: string; projectedHash: string }> {
  validate.list(contributions, 1000)
  const result: Array<{ rootId: string; projectedHash: string }> = []
  const seen = new Set<string>()
  const verified = new Map<string, LearningReceipt>()
  const query = data.db.prepare(
    'SELECT job_id FROM learning_coverage WHERE scope=? AND root_id=? AND projected_hash=? LIMIT 1',
  )
  for (const item of contributions) {
    validate.text(item.rootId, 200)
    validate.text(item.projectedHash, 200)
    validate.check(
      !data.tombstoned(identifier('learning-projection', scope, item.rootId, item.projectedHash)),
      'Learning contribution was forgotten',
    )
    const key = stable([item.rootId, item.projectedHash])
    const row = query.get(scope, item.rootId, item.projectedHash)
    if (!seen.has(key) && row) {
      const jobId = String(row.job_id)
      const input = verified.get(jobId) ?? receipt(data, data.require('jobs', jobId))
      validate.check(
        data.get('learningResults', jobId) &&
          input.covered.some(
            (source) =>
              source.rootId === item.rootId && source.projectedHash === item.projectedHash,
          ),
        'Invalid learning coverage receipt',
      )
      verified.set(jobId, input)
      result.push({ rootId: item.rootId, projectedHash: item.projectedHash })
    }
    seen.add(key)
  }
  return result
}
export function previous(data: Data, key: string): BrainJob | undefined {
  const row = data.db
    .prepare(
      `SELECT d.id FROM documents d JOIN documents j ON j.kind='jobs' AND j.id=d.id WHERE d.kind='learningInputs' AND json_extract(d.value,'$.value.attemptKey')=? ORDER BY d.rowid DESC LIMIT 1`,
    )
    .get(key)
  return row ? data.require('jobs', String(row.id)) : undefined
}
/** Every visible dependency invalidates the whole inference, not just its cited suffix. */
export function dependentEvidence(
  data: Data,
  roots: Set<string>,
  selected: Set<string>,
): Set<string> {
  const ids = new Set<string>()
  for (const stored of data.all('learningInputs')) {
    const input = stored.value
    if (
      input.dependencyRootIds.some((root) => roots.has(identifier('root', input.scope, root))) ||
      input.evidenceIds.some((id) => selected.has(id))
    )
      input.evidenceIds.forEach((id) => ids.add(id))
  }
  return ids
}
export function forgetLearning(data: Data, jobId: string, roots: Set<string>): void {
  const input = data.get('learningInputs', jobId)?.value
  if (input)
    for (const source of input.evidence)
      if (source.rootIds.some((root) => roots.has(identifier('root', input.scope, root))))
        data.tombstone(
          identifier('learning-projection', input.scope, source.rootId, source.projectedHash),
        )
  if (input)
    for (const dependency of input.dependencies)
      if (roots.has(identifier('root', input.scope, dependency.entryId))) {
        const source = input.covered.find((item) => item.entryId === dependency.entryId)
        if (source)
          data.tombstone(
            identifier('learning-projection', input.scope, source.rootId, source.projectedHash),
          )
      }
  data.db.prepare('DELETE FROM learning_dependencies WHERE job_id=?').run(jobId)
  data.remove('learningInputs', jobId)
  data.remove('learningResults', jobId)
  data.db.prepare('DELETE FROM learning_coverage WHERE job_id=?').run(jobId)
}
