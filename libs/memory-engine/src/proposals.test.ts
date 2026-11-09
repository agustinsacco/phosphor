import { describe, expect, it } from 'vitest'
import { approve, extraction, fixture, lane, vector } from './test-support'
import { cosine } from './vectors'

describe('Brain proposal deduplication', () => {
  it('keeps the first within a proposal at cosine >= 0.86 and retains a just-below candidate', () => {
    const { store } = fixture()
    const job = store.enqueue(lane(), 'queued')
    const data = extraction(job.id)
    const at = vector(0.86, Math.sqrt(1 - 0.86 ** 2))
    const below = vector(0.8599, 0, Math.sqrt(1 - 0.8599 ** 2))
    expect(cosine(vector(1), at)).toBeGreaterThanOrEqual(0.86)
    expect(cosine(vector(1), below)).toBeLessThan(0.86)
    data.memories = [
      data.memories[0]!,
      { ...data.memories[0]!, summary: 'Reworded ownership.' },
      data.memories[1]!,
    ]
    data.vectors = [vector(1), at, below]
    expect(store.propose(data)).toMatchObject({ kept: 2, duplicates: 1 })
    expect(store.proposal(job.id).memories.map((item) => item.memory.summary)).toEqual([
      data.memories[0]!.summary,
      data.memories[2]!.summary,
    ])
    store.review(job.id, [0, 1], 0)
    expect(store.knowledge().memories).toHaveLength(2)
  })
  it('reconfirms active memories and keeps confirmation-only proposals reviewable', () => {
    const { store } = fixture()
    approve(store)
    const job = store.enqueue(lane({ leafId: 'next' }), 'queued')
    expect(store.propose(extraction(job.id))).toMatchObject({
      kept: 0,
      duplicates: 0,
      reconfirmed: 2,
    })
    expect(store.job(job.id)).toMatchObject({ state: 'review', memories: 0 })
    expect(store.proposal(job.id).confirmations).toHaveLength(2)
  })
  it('does not dedup against superseded memories, but an exemption only covers its named target', () => {
    const { store, db } = fixture()
    approve(store)
    const old = store.knowledge().memories.find((item) => item.summary.includes('owns'))!
    const job = store.enqueue(lane({ leafId: 'next' }), 'queued')
    const data = extraction(job.id)
    data.memories = [{ ...data.memories[0]!, supersedes: old.id }]
    data.vectors = [vector(0, 1)]
    expect(store.propose(data)).toMatchObject({ kept: 0, duplicates: 0, reconfirmed: 1 })
    db.prepare("UPDATE memories SET state='superseded' WHERE id=?").run(old.id)
    data.vectors = [vector(1)]
    data.memories[0]!.supersedes = null
    expect(store.propose(data)).toMatchObject({ kept: 1, duplicates: 0 })
  })
  it('replaces a proposal and its vectors without leaving old rows', () => {
    const { store, db } = fixture()
    const job = store.enqueue(lane(), 'queued')
    store.propose(extraction(job.id))
    const data = extraction(job.id)
    data.memories = [data.memories[1]!]
    data.vectors = [vector(0, 1)]
    store.propose(data)
    expect(store.proposal(job.id).memories[0]?.memory.summary).toContain('Tom Lee')
    expect(db.prepare('SELECT COUNT(*) AS n FROM proposal_vectors').get()).toEqual({ n: 1 })
  })
  it('validates vectors before changing the proposal', () => {
    const { store } = fixture()
    const job = store.enqueue(lane(), 'queued')
    const data = extraction(job.id)
    data.vectors = [new Float32Array(3), vector(0, 1)]
    expect(() => store.propose(data)).toThrow('768 finite values')
    expect(store.job(job.id)?.state).toBe('queued')
    data.vectors = []
    expect(() => store.propose(data)).toThrow('missing a vector')
  })
})
