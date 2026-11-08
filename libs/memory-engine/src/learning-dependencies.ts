import type { BrainLearningStart } from '@phosphor/shared/brain-learning-jobs'
import { type Data, identifier, stable } from './data'
import * as validate from './validation'

/** The trusted host attests original input descriptors; these are never extra witnesses. */
export function validateDependencies(input: BrainLearningStart): void {
  validate.list(input.dependencies, 1000)
  validate.check(
    input.dependencies.length <= input.checkpoint.sourceEntryCount &&
      input.covered.length <= input.checkpoint.sourceEntryCount,
    'Learning descriptors exceed selected ancestry count',
  )
  const ids = new Set<string>()
  for (const dependency of input.dependencies) {
    validate.check(
      Object.keys(dependency).sort().join(',') === 'entryHash,entryId,parentId,rootId',
      'Invalid original dependency descriptor',
    )
    for (const value of [dependency.entryId, dependency.entryHash, dependency.rootId])
      validate.text(value, 200)
    if (dependency.parentId !== null) validate.text(dependency.parentId, 200)
    validate.check(!ids.has(dependency.entryId), 'Duplicate original dependency')
    ids.add(dependency.entryId)
    const projected = input.covered.find((item) => item.entryId === dependency.entryId)
    if (projected)
      validate.check(
        projected.entryHash === dependency.entryHash &&
          projected.rootId === dependency.rootId &&
          projected.parentId === dependency.parentId,
        'Original dependency differs from frozen contribution',
      )
  }
  validate.check(
    ids.size === input.dependencyRootIds.length &&
      input.dependencyRootIds.every((id) => ids.has(id)),
    'Unbound original dependency descriptors',
  )
}
type DependencyIdentity = Pick<
  BrainLearningStart,
  'jobId' | 'scope' | 'dependencies' | 'dependencyRootIds'
>
export function saveDependencies(data: Data, input: DependencyIdentity): void {
  const insert = data.db.prepare('INSERT INTO learning_dependencies VALUES (?,?,?,?)')
  for (const dependency of input.dependencies)
    insert.run(input.jobId, input.scope, dependency.entryId, data.now())
}
export function assertDependencies(data: Data, input: DependencyIdentity): void {
  const rows = data.db
    .prepare(
      'SELECT scope,root_id FROM learning_dependencies WHERE job_id=? ORDER BY root_id LIMIT 1001',
    )
    .all(input.jobId)
  validate.check(
    rows.every((row) => row.scope === input.scope) &&
      stable(rows.map((row) => String(row.root_id))) ===
        stable([...input.dependencyRootIds].sort()),
    'Learning dependency anchor receipt integrity failure',
  )
}
/** Expiry forgets original roots, not fabricated readable evidence IDs. */
export function expiredDependencyRoots(
  data: Data,
  cutoff: number,
  evidenceIds: string[],
): Set<string> {
  const jobs = evidenceIds.length
    ? `SELECT DISTINCT d.id FROM documents d,json_each(d.value,'$.evidenceIds') e WHERE d.kind='jobs' AND e.value IN (${evidenceIds.map(() => '?').join(',')})`
    : 'SELECT job_id FROM learning_dependencies WHERE retained_at<=? ORDER BY job_id LIMIT 1'
  const params = evidenceIds.length ? evidenceIds : [cutoff]
  const rows = data.db
    .prepare(
      `SELECT scope,root_id FROM learning_dependencies WHERE retained_at<=? AND job_id IN (${jobs})`,
    )
    .iterate(cutoff, ...params)
  const roots = new Set<string>()
  for (const row of rows) roots.add(identifier('root', String(row.scope), String(row.root_id)))
  return roots
}
