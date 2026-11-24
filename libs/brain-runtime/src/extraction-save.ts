import {
  BRAIN_TEMPORARY_DAYS,
  type BrainExtractionOutcome,
  type BrainJob,
} from '@phosphor/shared/brain'
import type { BrainStore, Proposal, ProposalMemory, SavedRead } from '@phosphor/memory-engine/types'
import type { BrainServiceOptions, BrainSearchPort } from './types'
import { ExtractionRecord } from './extraction-record'

export type ReadOptions = BrainServiceOptions & { onReadSaved?(): void }

function heldOutcome(
  memory: ProposalMemory,
  proposal: Proposal,
  now: number,
): Partial<BrainExtractionOutcome> {
  if (memory.hold === 'personal')
    return {
      status: 'dropped',
      reason: 'About a person: never saved',
      memoryId: undefined,
      proposalIndex: undefined,
    }
  if (memory.hold !== 'temporary') return {}
  const citations = [...memory.citations, ...memory.links.map((l) => l.citation)]
  const observed =
    Math.max(0, ...citations.map((c) => proposal.evidence[c.evidence]!.observedAt)) || now
  const until = memory.validTo ?? observed + BRAIN_TEMPORARY_DAYS * 86400000
  return { status: 'kept', reason: `Saved until ${new Date(until).toISOString().slice(0, 10)}` }
}

/** Save candidate indices first: the transaction attaches each resulting memory id to its outcome. */
export function saveWithRecord(
  store: BrainStore,
  record: ExtractionRecord,
  proposal: Proposal,
  outcomes: BrainExtractionOutcome[],
  now: number,
) {
  const final = outcomes.map((o) => {
    const memory =
      o.proposalIndex === undefined
        ? proposal.confirmations.find(
            (c) => c.memoryId === o.memoryId && c.claim.summary === o.summary,
          )?.claim
        : proposal.memories[o.proposalIndex]
    return memory ? { ...o, ...heldOutcome(memory, proposal, now) } : o
  })
  record.outcomes(final)
  try {
    return store.saveRead(proposal)
  } catch (error) {
    record.outcomes(
      outcomes.map((o) =>
        o.proposalIndex !== undefined || o.status === 'reconfirms'
          ? { ...o, status: 'dropped', reason: 'Not saved' }
          : o,
      ),
    )
    throw error
  }
}

export function saveLegacy(
  job: BrainJob,
  store: BrainStore,
  proposal: Proposal,
  now: () => number,
) {
  for (const m of [...proposal.memories, ...proposal.confirmations.map((c) => c.claim)]) {
    m.importance ??= 1
    for (const l of m.links) l.label ??= ''
  }
  let previous
  try {
    previous = store.extraction(job.id)
  } catch {
    /* Some legacy reads have no record. */
  }
  const record = new ExtractionRecord(job, store, now, previous?.thinking ?? 'medium')
  const outcomes =
    previous?.outcomes.filter((o) => !o.candidate.includes(':rejected-')) ??
    proposal.memories.map((m, i) => ({
      candidate: `claim:${i + 1}`,
      summary: m.summary,
      proposalIndex: i,
      status: 'kept' as const,
    }))
  return saveWithRecord(store, record, proposal, outcomes, now())
}

export async function afterReadSaved(
  state: SavedRead['state'],
  job: BrainJob,
  options: ReadOptions,
  search: BrainSearchPort,
) {
  try {
    await search.refresh()
  } catch (error) {
    options.log?.('Brain search refresh failed after saving', {
      jobId: job.id,
      error: error instanceof Error ? error.message : String(error),
    })
  }
  if (state === 'done') options.onReadSaved?.()
}
