import { describe, expect, it } from 'vitest'
import { approve, extraction, fixture, lane, vector } from './test-support'

describe('Brain proposal review', () => {
  it('approves a subset with only its cited evidence and entities; exposes bounded quote context', () => {
    const { store, db } = fixture()
    const job = store.enqueue(lane(), 'queued')
    const data = extraction(job.id)
    data.evidence[0]!.text = `${'B'.repeat(200)}Rina owns Harbor.${'A'.repeat(200)}`
    store.propose(data)
    const view = store.proposal(job.id)
    expect(view.entities.map((item) => item.label)).toEqual(['Harbor', 'Rina Okafor', 'Tom Lee'])
    expect(view.memories[0]?.quotes[0]).toEqual({
      quote: 'Rina owns Harbor.',
      before: 'B'.repeat(160),
      after: 'A'.repeat(160),
      label: 'You · Nov 6, 12:47',
    })
    store.review(job.id, [0], view.revision)
    expect(store.snapshot()).toMatchObject({
      revision: 1,
      counts: { memories: 1, entities: 2 },
      jobs: [],
    })
    const knowledge = store.knowledge()
    expect(knowledge.entities.map((item) => item.label)).not.toContain('Tom Lee')
    expect(knowledge.memories[0]).toMatchObject({
      branch: null,
      origin: data.origin,
      summary: data.memories[0]!.summary,
    })
    expect(store.memory(knowledge.memories[0]!.id).quotes).toEqual(view.memories[0]!.quotes)
    expect(db.prepare('SELECT COUNT(*) AS n FROM evidence').get()).toEqual({ n: 1 })
    expect(db.prepare('SELECT COUNT(*) AS n FROM proposal_vectors').get()).toEqual({ n: 0 })
    expect(store.job(job.id)).toMatchObject({ state: 'done', memories: 1 })
  })
  it('refuses stale review without partial writes or losing its proposal', () => {
    const { store } = fixture()
    approve(store)
    const job = store.enqueue(lane({ leafId: 'leaf-2' }), 'queued')
    const data = extraction(job.id, {
      vectors: [vector(0, 0, 1)],
      memories: [{ ...extraction(job.id).memories[0]!, summary: 'Rina chose daily backups.' }],
    })
    store.propose(data)
    const view = store.proposal(job.id)
    store.forget(store.knowledge().memories[0]!.id)
    expect(() => store.review(job.id, [0], view.revision)).toThrow(
      'Brain changed while you were reviewing. Reopen the review.',
    )
    expect(store.proposal(job.id).memories).toHaveLength(1)
    expect(store.knowledge().memories).toHaveLength(1)
  })
  it.each([null, []])('rejects all with keep=%j and remembers the leaf', (keep) => {
    const { store } = fixture()
    const job = store.enqueue(lane(), 'queued')
    store.propose(extraction(job.id))
    store.review(job.id, keep, store.snapshot().revision)
    expect(store.snapshot().counts.memories).toBe(0)
    expect(store.job(job.id)).toMatchObject({ state: 'done', memories: 0 })
    expect(() => store.proposal(job.id)).toThrow('Brain proposal not found.')
    expect(() => store.enqueue(lane(), 'queued')).toThrow('Nothing new')
  })
  it('rolls back entities, memories, evidence and revision when a later kept memory is invalid', () => {
    const { store, db } = fixture()
    const job = store.enqueue(lane(), 'queued')
    const data = extraction(job.id)
    data.memories[1]!.subject = 'missing'
    store.propose(data)
    expect(() => store.review(job.id, [0, 1], 0)).toThrow('Brain proposal entity not found.')
    expect(store.snapshot()).toMatchObject({ revision: 0, counts: { memories: 0, entities: 0 } })
    expect(db.prepare('SELECT COUNT(*) AS n FROM evidence').get()).toEqual({ n: 0 })
    expect(store.proposal(job.id).memories).toHaveLength(2)
  })
  it('validates indexes before writing and only approves repeated indexes once', () => {
    const { store } = fixture()
    const job = store.enqueue(lane(), 'queued')
    store.propose(extraction(job.id))
    expect(() => store.review(job.id, [0, 20], 0)).toThrow(
      'Brain proposal memory index is invalid.',
    )
    expect(store.snapshot().revision).toBe(0)
    store.review(job.id, [1, 1], 0)
    expect(store.knowledge().memories).toHaveLength(1)
    expect(store.knowledge().memories[0]).toMatchObject({
      branch: 'billing',
      validFrom: 1700000000000,
    })
  })
  it('supersedes the named active memory even when its vector is identical', () => {
    const { store, db } = fixture()
    approve(store)
    const old = store.knowledge().memories.find((item) => item.summary.includes('owns'))!
    const job = store.enqueue(lane({ leafId: 'changed' }), 'queued')
    const data = extraction(job.id)
    data.memories = [
      {
        ...data.memories[0]!,
        supersedes: old.id,
        summary: 'Rina Okafor delegates Harbor billing ownership.',
      },
    ]
    data.vectors = [vector(1)]
    expect(store.propose(data)).toMatchObject({ kept: 1, duplicates: 0 })
    store.review(job.id, [0], store.snapshot().revision)
    expect(store.knowledge().memories.map((item) => item.id)).not.toContain(old.id)
    expect(db.prepare('SELECT state FROM memories WHERE id=?').get(old.id)).toEqual({
      state: 'superseded',
    })
    expect(db.prepare('SELECT * FROM vectors WHERE memory_id=?').get(old.id)).toBeUndefined()
    expect(db.prepare('SELECT * FROM memory_fts WHERE id=?').get(old.id)).toBeUndefined()
    expect(store.snapshot().revision).toBe(2)
  })
  it('approves a pending proposal after the entity it reuses lost its last memory', () => {
    const { store } = fixture()
    approve(store)
    const rina = store.knowledge().entities.find((item) => item.label === 'Rina Okafor')!
    const job = store.enqueue(lane({ leafId: 'leaf-2' }), 'queued')
    const base = extraction(job.id).memories[0]!
    store.propose(
      extraction(job.id, {
        entities: [],
        vectors: [vector(0, 0, 1)],
        memories: [
          { ...base, subject: rina.id, object: null, summary: 'Rina Okafor chose daily backups.' },
        ],
      }),
    )
    for (const memory of store.knowledge().memories) store.forget(memory.id)
    expect(store.knowledge().entities).toEqual([])
    const view = store.proposal(job.id)
    expect(view.entities.map((item) => item.label)).toEqual(['Rina Okafor'])
    store.review(job.id, [0], view.revision)
    const knowledge = store.knowledge()
    expect(knowledge.memories.map((item) => item.summary)).toEqual([
      'Rina Okafor chose daily backups.',
    ])
    expect(knowledge.entities.map((item) => item.label)).toEqual(['Rina Okafor'])
  })
})
