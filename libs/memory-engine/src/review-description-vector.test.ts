import { DatabaseSync } from 'node:sqlite'
import { expect, it } from 'vitest'
import type { BrainReviewDecision } from '@phosphor/shared/brain'
import { approve, extraction, lane, searchFixture, vector } from './test-support'
import type { BrainStore } from './types'
import { decodeVector } from './vectors'

const decide = (patch: Partial<BrainReviewDecision> = {}): BrainReviewDecision => ({
  memories: [0],
  identities: {},
  groups: [],
  descriptions: [],
  confirmations: [],
  ...patch,
})
/** Harbor was stored as inventory storage; it lies along the first axis. */
const inventory = vector(1, 0, 0)
/** A later read describes Harbor as payment processing; it lies along the second axis. */
const payments = vector(0, 1, 0)

function storeHarbor(store: BrainStore): string {
  const base = extraction('')
  approve(store, {
    entities: [{ ...base.entities[0]!, description: 'Inventory storage' }],
    entityVectors: [inventory],
    memories: [{ ...base.memories[0]!, entities: ['harbor'], links: [] }],
    memoryVectors: [vector(0, 0, 1)],
  })
  return store.overview(300).nodes.find((node) => node.label === 'Harbor')!.id
}
/** The second read reuses Harbor with its own description and that description's vector. */
function rereadHarbor(store: BrainStore, harbor: string, descriptions: string[]): void {
  const job = store.enqueue(lane({ sessionId: 'ledger-lane' }), 'queued')
  const base = extraction(job.id, { computedRevision: store.knowledgeRevision() })
  store.propose({
    ...base,
    entities: [
      {
        ...base.entities[0]!,
        description: 'Payment processing',
        decision: 'reuse',
        entityId: harbor,
      },
    ],
    entityVectors: [payments],
    memories: [{ ...base.memories[0]!, entities: ['harbor'], links: [] }],
    memoryVectors: [vector(0, 0, 1)],
  })
  store.review(job.id, decide({ descriptions }), store.proposal(job.id).revision)
}
function storedVector(path: string, harbor: string): number[] {
  const db = new DatabaseSync(path, { readOnly: true })
  try {
    const row = db
      .prepare('SELECT v.vector FROM entity_vectors v JOIN entities e ON e.n=v.entity WHERE e.id=?')
      .get(harbor) as { vector: Uint8Array }
    return [...decodeVector(row.vector)]
  } finally {
    db.close()
  }
}

it("stores the read's description vector when the owner takes its description, and search follows", async () => {
  const { store, search, path } = searchFixture()
  const harbor = storeHarbor(store)
  await search.refresh()
  expect(search.nearestEntities([payments], 1)[0]![0]?.score ?? 0).toBeLessThan(0.5)
  rereadHarbor(store, harbor, ['harbor'])
  expect(store.entity(harbor).entity.description).toBe('Payment processing')
  expect(storedVector(path, harbor)).toEqual([...payments])
  await search.refresh()
  expect(search.nearestEntities([payments], 1)[0]![0]).toMatchObject({ id: harbor })
  expect(search.nearestEntities([payments], 1)[0]![0]!.score).toBeGreaterThan(0.99)
})

it('keeps the stored vector when the owner keeps the stored description', async () => {
  const { store, search, path } = searchFixture()
  const harbor = storeHarbor(store)
  await search.refresh()
  rereadHarbor(store, harbor, [])
  expect(store.entity(harbor).entity.description).toBe('Inventory storage')
  expect(storedVector(path, harbor)).toEqual([...inventory])
  await search.refresh()
  expect(search.nearestEntities([inventory], 1)[0]![0]).toMatchObject({ id: harbor })
})
