import { BRAIN_PREDICATES, type BrainProposalView } from '@phosphor/shared/brain'
import { all, one, run, transaction, type Context } from './database'
import { entity } from './entities'
import { job, updateJob } from './jobs'
import { memoryCard, quoteContext } from './knowledge'
import type { Citation, Proposal, ProposalResult } from './types'
import { decodeVector, encodeVector } from './vectors'

export function storedProposal(ctx: Context, jobId: string): Proposal | undefined {
  const row = one<{ payload: string }>(ctx, 'SELECT payload FROM proposals WHERE job_id=?', jobId)
  if (!row) return undefined
  const value = JSON.parse(row.payload) as Proposal
  for (const kind of ['memory', 'entity'] as const) {
    value[kind === 'memory' ? 'memoryVectors' : 'entityVectors'] = all<{ vector: Uint8Array }>(
      ctx,
      'SELECT vector FROM proposal_vectors WHERE job_id=? AND kind=? ORDER BY idx',
      jobId,
      kind,
    ).map((row) => decodeVector(row.vector))
  }
  return value
}
export function readProposal(ctx: Context, jobId: string): Proposal {
  const proposal = storedProposal(ctx, jobId)
  if (!proposal) throw new Error('Brain proposal not found.')
  return proposal
}
function validate(ctx: Context, value: Proposal): void {
  if (!job(ctx, value.jobId)) throw new Error('Brain job not found.')
  if (
    value.memoryVectors.length !== value.memories.length ||
    value.entityVectors.length !== value.entities.length
  )
    throw new Error('Brain proposal vector count is invalid.')
  if (value.memories.length > 300) throw new Error('Brain proposal exceeds the 300 memory budget.')
  const refs = new Set(value.entities.map((item) => item.ref))
  if (refs.size !== value.entities.length) throw new Error('Duplicate Brain identity ref.')
  const checkEntity = (id: string) => {
    if (!refs.has(id) && !entity(ctx, id)) throw new Error('Brain proposal entity not found.')
  }
  const citation = (item: Citation) => {
    if (!Number.isInteger(item.evidence) || !value.evidence[item.evidence] || !item.quote.trim())
      throw new Error('Brain citation evidence not found.')
  }
  const target = (id: string) => {
    if (memoryCard(ctx, id).state === 'superseded')
      throw new Error('Brain target is no longer active.')
  }
  for (const item of value.entities) {
    if (!item.ref || !item.label.trim()) throw new Error('Brain identity is invalid.')
    if (item.decision === 'reuse' && !item.entityId)
      throw new Error('Brain reused identity has no target.')
    for (const id of [...item.candidates, ...(item.entityId ? [item.entityId] : [])])
      if (!entity(ctx, id)) throw new Error('Brain identity target not found.')
  }
  for (const item of value.memories) {
    item.entities.forEach(checkEntity)
    for (const link of item.links) {
      checkEntity(link.subject)
      checkEntity(link.object)
      citation(link.citation)
      if (!BRAIN_PREDICATES.includes(link.predicate)) throw new Error('Brain predicate is invalid.')
    }
    item.citations.forEach(citation)
    if ((item.action === 'add') !== (item.target === null))
      throw new Error('Brain action target is invalid.')
    if (item.target) target(item.target)
  }
  for (const item of value.confirmations) {
    target(item.memoryId)
    item.citations.forEach(citation)
  }
  for (const group of value.groups) {
    group.members.forEach(checkEntity)
    if (group.parent.entityId && !entity(ctx, group.parent.entityId))
      throw new Error('Brain group parent not found.')
  }
  value.memoryVectors.forEach(encodeVector)
  value.entityVectors.forEach(encodeVector)
}
export function propose(ctx: Context, value: Proposal): ProposalResult {
  validate(ctx, value)
  transaction(ctx, () => {
    run(ctx, 'DELETE FROM proposals WHERE job_id=?', value.jobId)
    const nonempty = value.memories.length || value.confirmations.length || value.groups.length
    if (nonempty) {
      run(
        ctx,
        'INSERT INTO proposals VALUES (?,?)',
        value.jobId,
        JSON.stringify({ ...value, memoryVectors: [], entityVectors: [] }),
      )
      for (const kind of ['memory', 'entity'] as const)
        value[kind === 'memory' ? 'memoryVectors' : 'entityVectors'].forEach((vector, index) =>
          run(
            ctx,
            'INSERT INTO proposal_vectors VALUES (?,?,?,?)',
            value.jobId,
            kind,
            index,
            encodeVector(vector),
          ),
        )
    }
    run(ctx, 'UPDATE jobs SET computed_revision=? WHERE id=?', value.computedRevision, value.jobId)
    updateJob(ctx, value.jobId, {
      state: nonempty ? 'review' : 'empty',
      memories: value.memories.length,
    })
  })
  return {
    memories: value.memories.length,
    confirmations: value.confirmations.length,
    identities: value.entities.length,
  }
}
export function proposal(ctx: Context, jobId: string): BrainProposalView {
  const value = readProposal(ctx, jobId)
  return {
    job: job(ctx, jobId)!,
    revision: value.computedRevision,
    held: value.held,
    identities: value.entities.map((item) => ({
      ...item,
      candidates: item.candidates.map((id) => entity(ctx, id)!).filter(Boolean),
    })),
    groups: value.groups.map((item, index) => ({
      ...item,
      index,
      labels: item.members.map(
        (id) => value.entities.find((item) => item.ref === id)?.label ?? entity(ctx, id)!.label,
      ),
    })),
    memories: value.memories.map((item, index) => ({
      ...item,
      index,
      links: item.links.map((link) => ({
        subject: link.subject,
        object: link.object,
        predicate: link.predicate,
        quote: link.citation.quote,
      })),
      target: item.target
        ? { id: item.target, summary: memoryCard(ctx, item.target).summary }
        : null,
      quotes: item.citations.map((citation) =>
        quoteContext(citation.quote, value.evidence[citation.evidence]!),
      ),
    })),
    confirmations: value.confirmations.map((item) => ({
      id: item.memoryId,
      summary: memoryCard(ctx, item.memoryId).summary,
    })),
  }
}
