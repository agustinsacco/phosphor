import { expect, it } from 'vitest'
import { approve, extraction, fixture, running, vector } from './test-support'

function setup() {
  const { store, db } = fixture()
  const [target] = approve(store)
  const job = running(store, { sessionId: 'second' })
  const p = extraction(job, {
    computedRevision: store.knowledgeRevision(),
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
  expect(() => store.saveRead(p)).toThrow('entity not found')
  c.claim.entities.pop()
  c.claim.citations[0]!.evidence = 100
  expect(() => store.saveRead(p)).toThrow('evidence not found')
  c.claim.citations[0]!.evidence = 0
  c.vector = new Float32Array([1])
  expect(() => store.saveRead(p)).toThrow()
})
it('counts confirmations together with memories against the 300-claim budget', () => {
  const { store, p } = setup()
  p.confirmations = Array.from({ length: 300 }, () => p.confirmations[0]!)
  p.memories = [extraction('').memories[0]!]
  p.memoryVectors = [vector()]
  expect(() => store.saveRead(p)).toThrow('300 memory budget')
})
it('scrubs repeats before saving them and leaves no proposal rows', () => {
  const { store, db, p, job } = setup()
  const c = p.confirmations[0]!
  c.claim.summary = 'Bearer made-up-secret'
  c.claim.citations[0]!.quote = 'Bearer made-up-secret'
  c.claim.links[0]!.citation.quote = 'Bearer made-up-secret'
  store.saveRead(p)
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all()
    .flatMap(({ name }) => db.prepare(`SELECT * FROM "${String(name)}"`).all())
  expect(JSON.stringify(rows)).not.toContain('made-up-secret')
  expect(store.job(job)?.state).toBe('done')
  expect(db.prepare('SELECT * FROM proposal_vectors').all()).toEqual([])
})
