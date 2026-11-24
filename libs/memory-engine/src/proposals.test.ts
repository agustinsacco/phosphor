import { describe, expect, it } from 'vitest'
import { approve, extraction, fixture, running, vector } from './test-support'

describe('Brain saved reads', () => {
  it('does not auto-confirm high cosine with different endpoints or negation', () => {
    const { store } = fixture()
    approve(store)
    const job = running(store, { leafId: 'next' })
    const data = extraction(job, { computedRevision: store.knowledgeRevision() })
    data.memories[0]!.summary = 'Rina does not own Harbor.'
    data.memoryVectors = [vector(1), vector(1)]
    expect(store.saveRead(data)).toMatchObject({ memories: 2, confirmed: 0 })
    expect(store.snapshot().counts.memories).toBe(4)
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
      store
        .memoryMatches(
          [{ entityIds: [tom], links: [{ subjectId: tom, predicate: 'owns', objectId: harbor }] }],
          5,
        )[0]!
        .map((match) => match.id),
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
      store
        .memoryMatches(
          [
            {
              entityIds: ['w1:n1'],
              links: [{ subjectId: 'w1:n1', predicate: 'owns', objectId: harbor }],
            },
          ],
          5,
        )[0]!
        .map((match) => match.id),
    ).toContain(owned.id)
  })
  it('validates vector counts, refs, targets and link evidence before writing', () => {
    const { store } = fixture()
    const job = running(store)
    const data = extraction(job)
    data.memoryVectors = []
    expect(() => store.saveRead(data)).toThrow('vector count')
    data.memoryVectors = [new Float32Array(3), vector()]
    expect(() => store.saveRead(data)).toThrow('768 finite')
    data.memoryVectors = [vector(), vector()]
    data.memories[0]!.links[0]!.subject = 'absent'
    expect(() => store.saveRead(data)).toThrow('entity not found')
    expect(store.job(job)?.state).toBe('running')
    expect(store.snapshot().counts.memories).toBe(0)
  })
})
