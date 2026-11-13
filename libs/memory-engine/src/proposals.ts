import { validateProposal } from './validation'
import type { BrainProposedMemory, BrainProposalView } from '@phosphor/shared/brain'
import { all, one, run, transaction, type Context } from './database'
import { entity } from './entities'
import { job, updateJob } from './jobs'
import { memoryCard, quoteContext } from './knowledge'
import type { Proposal, ProposalMemory, ProposalResult } from './types'
import { scrubProposal } from './proposal-text'
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
  const vectors = all<{ idx: number; vector: Uint8Array }>(
    ctx,
    "SELECT idx,vector FROM proposal_vectors WHERE job_id=? AND kind='confirmation' ORDER BY idx",
    jobId,
  )
  for (const row of vectors) value.confirmations[row.idx]!.vector = decodeVector(row.vector)
  return value
}
export function readProposal(ctx: Context, jobId: string): Proposal {
  const proposal = storedProposal(ctx, jobId)
  if (!proposal) throw new Error('Brain proposal not found.')
  return proposal
}
export function propose(ctx: Context, value: Proposal): ProposalResult {
  validateProposal(ctx, value)
  value = scrubProposal(value)
  transaction(ctx, () => {
    run(ctx, 'DELETE FROM proposals WHERE job_id=?', value.jobId)
    const nonempty = value.memories.length || value.confirmations.length || value.groups.length
    if (nonempty) {
      run(
        ctx,
        'INSERT INTO proposals VALUES (?,?)',
        value.jobId,
        JSON.stringify({
          ...value,
          memoryVectors: [],
          entityVectors: [],
          confirmations: value.confirmations.map((c) => ({ ...c, vector: [] })),
        }),
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
      value.confirmations.forEach((c, index) =>
        run(
          ctx,
          'INSERT INTO proposal_vectors VALUES (?,?,?,?)',
          value.jobId,
          'confirmation',
          index,
          encodeVector(c.vector),
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
    memories: value.memories.map((item, index) => ({ ...claimView(ctx, value, item), index })),
    confirmations: value.confirmations.map((item) => ({
      id: item.memoryId,
      summary: memoryCard(ctx, item.memoryId).summary,
      claim: claimView(ctx, value, item.claim),
    })),
  }
}

function claimView(
  ctx: Context,
  value: Proposal,
  item: ProposalMemory,
): Omit<BrainProposedMemory, 'index'> {
  return {
    ...item,
    links: item.links.map((link) => ({
      subject: link.subject,
      object: link.object,
      predicate: link.predicate,
      quote: link.citation.quote,
    })),
    target: item.target ? { id: item.target, summary: memoryCard(ctx, item.target).summary } : null,
    quotes: item.citations.map((citation) =>
      quoteContext(citation.quote, value.evidence[citation.evidence]!),
    ),
  }
}
