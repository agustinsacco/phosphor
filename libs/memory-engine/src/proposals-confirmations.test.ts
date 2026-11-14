import { expect, it } from 'vitest'
import { approve, extraction, fixture, lane, vector } from './test-support'

function setup() {
  const { store, db } = fixture()
  const [target] = approve(store)
  const job = store.enqueue(lane({ sessionId: 'second' }), 'queued')
  const p = extraction(job.id, {
    computedRevision: store.revision(),
    memories: [],
    memoryVectors: [],
  })
  p.confirmations = [{ memoryId: target!, claim: extraction('').memories[0]!, vector: vector() }]
  return { store, db, job, p }
}
it('validates retained confirmation references, evidence and vectors', () => {
  const { store, p } = setup()
  const c = p.confirmations[0]!
  c.claim.entities.push('unknown')
  expect(() => store.propose(p)).toThrow('entity not found')
  c.claim.entities.pop()
  c.claim.citations[0]!.evidence = 100
  expect(() => store.propose(p)).toThrow('evidence not found')
  c.claim.citations[0]!.evidence = 0
  c.vector = new Float32Array([1])
  expect(() => store.propose(p)).toThrow()
})
it('counts confirmations together with memories against the 300-claim budget', () => {
  const { store, p } = setup()
  p.confirmations = Array.from({ length: 300 }, () => p.confirmations[0]!)
  p.memories = [extraction('').memories[0]!]
  p.memoryVectors = [vector()]
  expect(() => store.propose(p)).toThrow('300 memory budget')
})
it('scrubs retained claims and stores confirmation vectors outside JSON with cascade cleanup', () => {
  const { store, db, p, job } = setup()
  const c = p.confirmations[0]!
  c.claim.summary = 'Bearer made-up-secret'
  c.claim.citations[0]!.quote = 'Bearer made-up-secret'
  c.claim.links[0]!.citation.quote = 'Bearer made-up-secret'
  store.propose(p)
  expect(JSON.stringify(store.storedProposal(job.id))).not.toContain('made-up-secret')
  expect(store.proposal(job.id).confirmations[0]!.claim.summary).not.toContain('made-up-secret')
  expect(db.prepare("SELECT kind FROM proposal_vectors WHERE kind='confirmation'").all()).toEqual([
    { kind: 'confirmation' },
  ])
  store.review(job.id, null, p.computedRevision)
  expect(db.prepare('SELECT * FROM proposal_vectors').all()).toEqual([])
})
