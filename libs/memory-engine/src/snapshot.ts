import type { BrainSnapshot } from '@phosphor/shared/brain'
import type { Data } from './data'

const ROW_LIMIT = 200
// 7.5MB of complete rows + 1.1MB metadata/array reserve = 8.6MB,
// leaving at least 400kB for the worker's 9MB response envelope.
const SECTION_BYTES = {
  entities: 2_500_000,
  claims: 1_500_000,
  proposals: 2_750_000,
  jobs: 500_000,
  evidence: 250_000,
}
function pack<T>(rows: T[], budget: number): { rows: T[]; truncated: boolean } {
  const packed: T[] = []
  let truncated = rows.length > ROW_LIMIT
  for (const row of rows.slice(0, ROW_LIMIT)) {
    const bytes = Buffer.byteLength(JSON.stringify(row)) + 1
    if (bytes > budget) {
      truncated = true
      continue
    }
    packed.push(row)
    budget -= bytes
  }
  return { rows: packed, truncated }
}
export function memorySnapshot(data: Data): BrainSnapshot {
  const scopes = data.prefs().workspaces.filter((scope) => data.enrolled(scope))
  const entities = pack(data.all('entities', scopes, ROW_LIMIT + 1), SECTION_BYTES.entities)
  const claims = pack(data.all('claims', scopes, ROW_LIMIT + 1), SECTION_BYTES.claims)
  const proposals = pack(data.activity('proposals', scopes, ROW_LIMIT + 1), SECTION_BYTES.proposals)
  const jobs = pack(data.activity('jobs', scopes, ROW_LIMIT + 1), SECTION_BYTES.jobs)
  const evidence = pack(
    data
      .all('evidence', scopes, ROW_LIMIT + 1)
      .map(({ id, scope, label, role, observedAt }) => ({ id, scope, label, role, observedAt })),
    SECTION_BYTES.evidence,
  )
  return {
    ...data.revision(),
    prefs: data.prefs(),
    entities: entities.rows,
    claims: claims.rows,
    proposals: proposals.rows,
    jobs: jobs.rows,
    evidence: evidence.rows,
    counts: {
      evidence: data.count('evidence'),
      claims: data.count('claims'),
      entities: data.count('entities'),
      vectors: Number(data.db.prepare('SELECT count(*) AS n FROM vectors').get()?.n),
    },
    truncated: [entities, claims, proposals, jobs, evidence].some((section) => section.truncated),
  }
}
