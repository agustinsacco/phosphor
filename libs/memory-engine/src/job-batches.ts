import type { BrainJob, BrainModel } from '@phosphor/shared/brain'
import { type Data, stable } from './data'
import { lstatSync } from 'node:fs'
import { join } from 'node:path'
import { blobName } from './evidence'
import { check } from './validation'
import { activeProcessor } from './source-exclusion'

function boundedSources(data: Data, candidates: { id: string; hash: string }[]): string[] {
  const ids: string[] = []
  let bytes = 0
  for (const source of candidates) {
    if (ids.length === 200) break
    const stat = lstatSync(join(data.blobs, blobName(source)))
    check(stat.isFile() && !stat.isSymbolicLink(), `Unsafe evidence blob ${source.id}`)
    if (stat.size > 60_000 && !ids.length)
      throw new Error(`Evidence ${source.id} exceeds 60000 source-byte budget`)
    if (bytes + stat.size > 60_000) break
    ids.push(source.id)
    bytes += stat.size
  }
  return ids.sort()
}

export function manualBatch(
  data: Data,
  scope: string,
  model: BrainModel,
): { active?: BrainJob; evidenceIds: string[] } {
  const revision = data.revision()
  const jobs = data.all('jobs', [scope])
  const current = (job: BrainJob) =>
    job.policyEpoch === revision.policyEpoch &&
    job.graphRevision === revision.graphRevision &&
    stable(job.model) === stable(model) &&
    job.evidenceIds.every((id) => data.get('evidence', id)?.scope === scope)
  const active = jobs
    .filter((job) => !job.learning && ['queued', 'running'].includes(job.state) && current(job))
    .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))[0]
  if (active) return { active, evidenceIds: active.evidenceIds }
  check(!activeProcessor(data), 'Another processor job is active')
  const byId = new Map(jobs.map((job) => [job.id, job]))
  const blocked = new Set<string>(
    jobs.filter((job) => job.learning).flatMap((job) => job.evidenceIds),
  )
  const processedRoots = new Set(
    data
      .all('learningInputs', [scope])
      .filter((input) => data.get('learningResults', input.value.jobId))
      .flatMap((input) => input.value.dependencyRootIds),
  )
  for (const source of data.all('evidence', [scope]))
    if (source.rootIds.some((root) => processedRoots.has(root))) blocked.add(source.id)
  for (const proposal of data.all('proposals', [scope])) {
    const job = byId.get(proposal.jobId)
    if (!job) continue
    const validPending =
      proposal.state === 'pending' &&
      proposal.policyEpoch === revision.policyEpoch &&
      proposal.graphRevision === revision.graphRevision &&
      current(job) &&
      job.state === 'proposed'
    if (proposal.state === 'applied' || validPending)
      for (const id of job.evidenceIds) blocked.add(id)
  }
  const attempted = new Set(jobs.flatMap((job) => job.evidenceIds))
  const candidates = data.db
    .prepare(
      `SELECT d.id,json_extract(d.value,'$.hash') AS hash,r.retained_at FROM documents d JOIN retained r ON r.id=d.id
    WHERE d.kind='evidence' AND d.scope=? ORDER BY r.retained_at,d.id`,
    )
    .all(scope)
    .filter((row) => !blocked.has(String(row.id)))
    .sort(
      (a, b) =>
        Number(attempted.has(String(a.id))) - Number(attempted.has(String(b.id))) ||
        Number(a.retained_at) - Number(b.retained_at) ||
        String(a.id).localeCompare(String(b.id)),
    )
  return {
    evidenceIds: boundedSources(
      data,
      candidates.map((row) => ({ id: String(row.id), hash: String(row.hash) })),
    ),
  }
}
