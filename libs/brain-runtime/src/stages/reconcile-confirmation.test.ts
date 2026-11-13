import { expect, it } from 'vitest'
import { approve, extraction, fixture, lane, vector } from '@phosphor/memory-engine/test-support'
import type { ProposalEntity } from '@phosphor/memory-engine/types'
import { FakeBrainSearch } from '../__fixtures__/fake-store'
import { trackAsk } from '../__fixtures__/stage-ask'
import { reconcile } from './reconcile'
import type { FoldedJob } from './fold'

async function confirmationFixture() {
  const { store, db } = fixture()
  const sample = extraction('')
  const [target] = approve(store, { memories: [sample.memories[0]!], memoryVectors: [vector()] })
  const before = store.memory(target!)
  const identities: ProposalEntity[] = sample.entities
    .map((e) => ({
      ...e,
      decision: 'reuse' as const,
      entityId: before.entities.find((old) => old.label === e.label)?.id ?? null,
    }))
    .filter((e) => e.entityId !== null)
  const claim = sample.memories[0]!
  const folded: FoldedJob = {
    entities: [],
    claims: [{ ref: 'c1', memory: claim }],
    evidence: sample.evidence,
    parents: [],
    outcomes: [],
  }
  const confirmations = await reconcile(
    folded,
    identities,
    store,
    new FakeBrainSearch(),
    [vector()],
    trackAsk().ask,
  )
  const job = store.enqueue(lane({ sessionId: 'another-lane' }), 'queued')
  const p = extraction(job.id, {
    computedRevision: store.revision(),
    entities: identities,
    entityVectors: identities.map(() => vector()),
    memories: [],
    memoryVectors: [],
    confirmations,
  })
  p.evidence[0] = { ...p.evidence[0]!, entryId: 'fresh', observedAt: 9999 }
  store.propose(p)
  return { store, db, target: target!, before, job, p, claim }
}

it('keeps the original confirmation claim, quotes and vector across proposal persistence and review view', async () => {
  const { store, job, claim } = await confirmationFixture()
  expect(store.storedProposal(job.id)?.confirmations[0]).toMatchObject({ claim, vector: vector() })
  expect(store.proposal(job.id).confirmations[0]).toMatchObject({
    claim: {
      summary: claim.summary,
      type: claim.type,
      entities: claim.entities,
      links: [
        expect.objectContaining({ subject: 'rina', object: 'harbor', quote: 'Rina owns Harbor.' }),
      ],
      quotes: [expect.objectContaining({ quote: 'Rina owns Harbor.' })],
    },
  })
})
it('identity override converts confirmation to an added claim without changing old evidence or observedAt', async () => {
  const { store, db, target, before, job, p } = await confirmationFixture()
  store.review(
    job.id,
    { memories: [], identities: { rina: 'new' }, groups: [] },
    p.computedRevision,
  )
  expect(store.memory(target).quotes).toEqual(before.quotes)
  expect(store.memory(target).memory.observedAt).toBe(before.memory.observedAt)
  expect(store.snapshot().counts.memories).toBe(2)
  const memories = store.entityMemories(
    before.entities.find((e) => e.label === 'Harbor')!.id,
    {},
    null,
  ).memories
  const added = memories.find((m) => m.id !== target)!
  expect(added.summary).toBe(before.memory.summary)
  expect(added.links[0]!.subjectId).not.toBe(before.memory.links[0]!.subjectId)
  expect(added.links[0]!.objectId).toBe(before.memory.links[0]!.objectId)
  expect(store.memory(added.id).quotes).toContainEqual(
    expect.objectContaining({ quote: 'Rina owns Harbor.' }),
  )
  expect(db.prepare('SELECT COUNT(*) n FROM memory_vectors').get()).toEqual({ n: 2 })
  expect(db.prepare('SELECT COUNT(*) n FROM proposal_vectors').get()).toEqual({ n: 0 })
})
