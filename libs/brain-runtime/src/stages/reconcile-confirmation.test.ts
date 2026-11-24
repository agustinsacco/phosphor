import { expect, it } from 'vitest'
import { approve, extraction, fixture, lane, vector } from '@phosphor/memory-engine/test-support'
import type { ProposalEntity } from '@phosphor/memory-engine/types'
import { FakeBrainSearch } from '../__fixtures__/fake-store'
import { trackAsk } from '../__fixtures__/stage-ask'
import { reconcile } from './reconcile'
import type { FoldedJob } from './fold'

async function confirmationFixture() {
  const { store } = fixture()
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
  return { target, p, claim }
}

it('carries the complete claim, citations and vector when confirming an existing memory', async () => {
  const { target, p, claim } = await confirmationFixture()
  expect(p.confirmations).toEqual([{ memoryId: target, claim, vector: vector() }])
})
