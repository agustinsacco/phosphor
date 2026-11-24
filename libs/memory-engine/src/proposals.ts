import { all, one, type Context } from './database'
import type { Proposal } from './types'
import { decodeVector } from './vectors'

/** A legacy read's proposal, stored before v8 saved reads directly. Older links read label ''. */
export function storedProposal(ctx: Context, jobId: string): Proposal | undefined {
  const row = one<{ payload: string }>(ctx, 'SELECT payload FROM proposals WHERE job_id=?', jobId)
  if (!row) return undefined
  const value = JSON.parse(row.payload) as Proposal
  for (const item of [...value.memories, ...value.confirmations.map((c) => c.claim)])
    item.links = item.links.map((link) => ({ ...link, label: link.label ?? '' }))
  for (const kind of ['memory', 'entity'] as const) {
    value[kind === 'memory' ? 'memoryVectors' : 'entityVectors'] = all<{ vector: Uint8Array }>(
      ctx,
      'SELECT vector FROM proposal_vectors WHERE job_id=? AND kind=? ORDER BY idx',
      jobId,
      kind,
    ).map((row) => decodeVector(row.vector))
  }
  const vectors = all<{ idx: number; vector: Uint8Array }>(
    ctx,
    "SELECT idx,vector FROM proposal_vectors WHERE job_id=? AND kind='confirmation' ORDER BY idx",
    jobId,
  )
  for (const row of vectors) value.confirmations[row.idx]!.vector = decodeVector(row.vector)
  return value
}
