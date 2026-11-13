import { describe, expect, it } from 'vitest'
import { approve, extraction, fixture, lane, vector } from './test-support'

describe('Brain v4 proposals', () => {
  it('does not auto-confirm high cosine with different endpoints or negation', () => {
    const { store } = fixture()
    approve(store)
    const job = store.enqueue(lane({ leafId: 'next' }), 'queued')
    const data = extraction(job.id, { computedRevision: store.revision() })
    data.memories[0]!.summary = 'Rina does not own Harbor.'
    data.memoryVectors = [vector(1), vector(1)]
    expect(store.propose(data)).toMatchObject({ memories: 2, confirmations: 0 })
    expect(store.proposal(job.id).memories[0]?.summary).toBe('Rina does not own Harbor.')
  })
  it('surfaces same-link, shared-entity and changed-owner candidates', () => {
    const { store } = fixture()
    approve(store)
    const nodes = store.overview(300).nodes
    const harbor = nodes.find((item) => item.label === 'Harbor')!.id
    const tom = nodes.find((item) => item.label === 'Tom Lee')!.id
    const old = store
      .entityMemories(harbor, {}, null)
      .memories.find((item) => item.summary.includes('owns'))!
    expect(
      store.memoryMatches(
        [{ entityIds: [tom], links: [{ subjectId: tom, predicate: 'owns', objectId: harbor }] }],
        5,
      )[0],
    ).toContain(old.id)
  })
  it("ignores a job's new entity refs but still finds owners of an existing object", () => {
    const { store } = fixture()
    expect(
      store.memoryMatches(
        [
          {
            entityIds: ['w1:n1'],
            links: [{ subjectId: 'w1:n1', predicate: 'owns', objectId: 'w1:n2' }],
          },
        ],
        5,
      ),
    ).toEqual([[]])
    approve(store)
    const harbor = store.overview(300).nodes.find((item) => item.label === 'Harbor')!.id
    const owned = store
      .entityMemories(harbor, {}, null)
      .memories.find((item) => item.summary.includes('owns'))!
    expect(
      store.memoryMatches(
        [
          {
            entityIds: ['w1:n1'],
            links: [{ subjectId: 'w1:n1', predicate: 'owns', objectId: harbor }],
          },
        ],
        5,
      )[0],
    ).toContain(owned.id)
  })
  it('replaces proposals and both vector kinds without old rows', () => {
    const { store, db } = fixture()
    const job = store.enqueue(lane(), 'queued')
    store.propose(extraction(job.id))
    const next = extraction(job.id)
    next.memories = next.memories.slice(1)
    next.memoryVectors = [vector()]
    store.propose(next)
    expect(store.proposal(job.id).memories[0]?.summary).toContain('Tom Lee')
    expect(db.prepare('SELECT COUNT(*) AS n FROM proposal_vectors').get()).toEqual({ n: 4 })
    expect(store.storedProposal(job.id)?.memoryVectors[0]).toEqual(vector())
  })
  it('validates vector counts, refs, targets and link evidence before writing', () => {
    const { store } = fixture()
    const job = store.enqueue(lane(), 'queued')
    const data = extraction(job.id)
    data.memoryVectors = []
    expect(() => store.propose(data)).toThrow('vector count')
    data.memoryVectors = [new Float32Array(3), vector()]
    expect(() => store.propose(data)).toThrow('768 finite')
    data.memoryVectors = [vector(), vector()]
    data.memories[0]!.links[0]!.subject = 'absent'
    expect(() => store.propose(data)).toThrow('entity not found')
    expect(store.job(job.id)?.state).toBe('queued')
  })
})
