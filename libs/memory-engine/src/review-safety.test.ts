import { expect, it } from 'vitest'
import type { BrainReviewDecision } from '@phosphor/shared/brain'
import { approve, extraction, fixture, lane } from './test-support'
import type { BrainStore, Proposal } from './types'

const decide = (patch: Partial<BrainReviewDecision> = {}): BrainReviewDecision => ({
  memories: [],
  identities: {},
  groups: [],
  descriptions: [],
  confirmations: [],
  ...patch,
})
/** Rina Okafor stored once, with her own description. */
function storedRina(store: BrainStore): string {
  approve(store, {
    entities: [{ ...extraction('').entities[1]!, description: 'Harbor lead' }],
    memories: [{ ...extraction('').memories[0]!, entities: ['rina'], links: [] }],
    memoryVectors: [extraction('').memoryVectors[0]!],
    entityVectors: [extraction('').entityVectors[1]!],
  })
  return store.overview(300).nodes.find((n) => n.label === 'Rina Okafor')!.id
}
/** A second read naming "Rina Okafor", unsure whether she is the stored one. */
function secondRead(store: BrainStore, rina: string, patch: Partial<Proposal['entities'][number]>) {
  const job = store.enqueue(lane({ leafId: 'leaf-2' }), 'queued')
  const base = extraction(job.id, { computedRevision: store.knowledgeRevision() })
  const proposal: Proposal = {
    ...base,
    entities: [
      {
        ...base.entities[1]!,
        description: 'Runs the Ledger rollout',
        decision: 'uncertain',
        entityId: null,
        candidates: [rina],
        ...patch,
      },
    ],
    memories: [{ ...base.memories[0]!, entities: ['rina'], links: [] }],
    memoryVectors: [base.memoryVectors[0]!],
    entityVectors: [base.entityVectors[1]!],
  }
  store.propose(proposal)
  return { job, proposal }
}

it('refuses an approval that leaves a required identity unanswered, and accepts an answer', () => {
  const { store } = fixture()
  const rina = storedRina(store)
  const { job } = secondRead(store, rina, { required: true })
  expect(store.proposal(job.id).identities[0]!.required).toBe(true)
  const revision = store.proposal(job.id).revision
  expect(() => store.review(job.id, decide({ memories: [0] }), revision)).toThrow(
    'Say whether “Rina Okafor” is someone Brain already knows or someone new before approving.',
  )
  expect(store.job(job.id)!.state).toBe('review')
  store.review(job.id, decide({ memories: [0], identities: { rina } }), revision)
  expect(store.snapshot().counts.entities).toBe(1)
})

it('lets a required identity go unanswered when nothing approved names it, and lets rejection through', () => {
  const { store } = fixture()
  const rina = storedRina(store)
  const first = secondRead(store, rina, { required: true })
  store.review(first.job.id, null, store.proposal(first.job.id).revision)
  expect(store.job(first.job.id)!.state).not.toBe('review')
})

it("replaces a reused record's description only when the decision lists it", () => {
  const { store } = fixture()
  const rina = storedRina(store)
  const kept = secondRead(store, rina, { decision: 'reuse', entityId: rina })
  store.review(kept.job.id, decide({ memories: [0] }), store.proposal(kept.job.id).revision)
  expect(store.entity(rina).entity.description).toBe('Harbor lead')
  const job = store.enqueue(lane({ leafId: 'leaf-3' }), 'queued')
  const base = extraction(job.id, { computedRevision: store.knowledgeRevision() })
  store.propose({
    ...kept.proposal,
    jobId: job.id,
    computedRevision: store.knowledgeRevision(),
    evidence: base.evidence,
  })
  store.review(
    job.id,
    decide({ memories: [0], descriptions: ['rina'] }),
    store.proposal(job.id).revision,
  )
  expect(store.entity(rina).entity.description).toBe('Runs the Ledger rollout')
})

it('refuses a description for a ref the proposal does not have', () => {
  const { store } = fixture()
  const rina = storedRina(store)
  const { job } = secondRead(store, rina, { decision: 'reuse', entityId: rina })
  expect(() =>
    store.review(
      job.id,
      decide({ memories: [0], descriptions: ['tom'] }),
      store.proposal(job.id).revision,
    ),
  ).toThrow('Brain description choice is invalid.')
})

it('shows each proposed memory with the hold it was stored with', () => {
  const { store } = fixture()
  const job = store.enqueue(lane(), 'queued')
  const data = extraction(job.id)
  data.memories[0]!.hold = 'personal'
  store.propose(data)
  expect(store.proposal(job.id).memories.map((m) => m.hold)).toEqual(['personal', null])
})
