import { expect, it } from 'vitest'
import type { BrainReviewDecision } from '@phosphor/shared/brain'
import { approve, extraction, fixture, lane, vector } from './test-support'
import type { Proposal } from './types'

const decide = (patch: Partial<BrainReviewDecision> = {}): BrainReviewDecision => ({
  memories: [],
  identities: {},
  groups: [],
  descriptions: [],
  confirmations: [],
  ...patch,
})
/**
 * Brain holds "Rina Okafor owns the Harbor billing service." A second lane says it again in a
 * confidential setting, so the confirmation is held as personal.
 */
function heldConfirmation(hold: 'personal' | null = 'personal') {
  const { store } = fixture()
  approve(store)
  const nodes = store.overview(300).nodes
  const id = (label: string) => nodes.find((node) => node.label === label)!.id
  const target = store
    .entityMemories(id('Rina Okafor'), {}, null)
    .memories.find((memory) => memory.summary.startsWith('Rina Okafor owns'))!.id
  const before = store.memory(target)
  const job = store.enqueue(lane({ sessionId: 'kestrel-lane' }), 'queued')
  const base = extraction(job.id, { computedRevision: store.knowledgeRevision() })
  const entities = base.entities
    .filter((entity) => entity.ref !== 'tom')
    .map((entity) => ({ ...entity, decision: 'reuse' as const, entityId: id(entity.label) }))
  const proposal: Proposal = {
    ...base,
    entities,
    entityVectors: entities.map(() => vector()),
    memories: [],
    memoryVectors: [],
    evidence: [
      {
        ...base.evidence[0]!,
        sessionId: 'kestrel-lane',
        entryId: 'calibration',
        observedAt: 9999,
        text: 'Calibration notes. Rina owns Harbor, and that is why her promotion stalls.',
      },
    ],
    confirmations: [{ memoryId: target, claim: { ...base.memories[0]!, hold }, vector: vector() }],
  }
  store.propose(proposal)
  return { store, job, target, before, revision: store.proposal(job.id).revision }
}

it('adds no evidence for a held confirmation the owner did not tick', () => {
  const { store, job, target, before, revision } = heldConfirmation()
  store.review(job.id, decide(), revision)
  expect(store.memory(target).quotes).toEqual(before.quotes)
  expect(store.memory(target).memory.observedAt).toBe(before.memory.observedAt)
  expect(store.snapshot().counts.memories).toBe(2)
  expect(store.job(job.id)!.state).toBe('done')
})

it('leaves the knowledge revision alone when an approval applies nothing', () => {
  const { store, job, revision } = heldConfirmation()
  const knowledge = store.knowledgeRevision()
  store.review(job.id, decide(), revision)
  expect(store.knowledgeRevision()).toBe(knowledge)
})

it('adds the evidence of a held confirmation the owner ticked', () => {
  const { store, job, target, before, revision } = heldConfirmation()
  store.review(job.id, decide({ confirmations: [0] }), revision)
  expect(store.memory(target).quotes).toHaveLength(before.quotes.length + 1)
  expect(store.memory(target).quotes).toContainEqual(
    expect.objectContaining({ quote: 'Rina owns Harbor.' }),
  )
  expect(store.memory(target).memory.observedAt).toBe(9999)
})

it('still adds the evidence of a confirmation that is not held, without a tick', () => {
  const { store, job, target, before, revision } = heldConfirmation(null)
  store.review(job.id, decide(), revision)
  expect(store.memory(target).quotes).toHaveLength(before.quotes.length + 1)
})

it('saves a held confirmation as a new memory after an identity change only when ticked', () => {
  const unticked = heldConfirmation()
  unticked.store.review(unticked.job.id, decide({ identities: { rina: 'new' } }), unticked.revision)
  expect(unticked.store.snapshot().counts.memories).toBe(2)
  const ticked = heldConfirmation()
  ticked.store.review(
    ticked.job.id,
    decide({ identities: { rina: 'new' }, confirmations: [0] }),
    ticked.revision,
  )
  expect(ticked.store.snapshot().counts.memories).toBe(3)
  expect(ticked.store.memory(ticked.target).quotes).toEqual(ticked.before.quotes)
})

it('refuses a tick on a confirmation that is not held, out of range or listed twice', () => {
  const held = heldConfirmation()
  for (const confirmations of [[1], [-1], [0.5], [0, 0]])
    expect(() => held.store.review(held.job.id, decide({ confirmations }), held.revision)).toThrow(
      'Brain confirmation choice is invalid.',
    )
  const plain = heldConfirmation(null)
  expect(() =>
    plain.store.review(plain.job.id, decide({ confirmations: [0] }), plain.revision),
  ).toThrow('Brain confirmation choice is invalid.')
  expect(plain.store.job(plain.job.id)!.state).toBe('review')
})
