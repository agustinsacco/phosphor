import { describe, expect, it } from 'vitest'
import { approve, extraction, fixture, vector } from './test-support'

describe('Brain entity resolution', () => {
  it('resolves by folded label or alias and kind, merges aliases, and reindexes earlier memories', () => {
    const { store } = fixture()
    approve(store)
    const original = store.knowledge().entities.find((item) => item.label === 'Harbor')!
    const base = extraction('unused')
    approve(store, {
      jobId: 'next',
      entities: [
        {
          key: 'service',
          label: ' ＨＡＲＢＯＲ   BILLING SERVICE ',
          kind: 'component',
          aliases: ['Invoicing Gateway', 'harbor'],
        },
      ],
      memories: [
        {
          ...base.memories[0]!,
          subject: 'service',
          object: null,
          predicate: 'about',
          summary: 'Daily settlement is final.',
        },
      ],
      vectors: [vector(0, 0, 1)],
    })
    const merged = store.knowledge().entities.find((item) => item.id === original.id)!
    expect(merged.aliases).toEqual(['Harbor billing service', 'Invoicing Gateway'])
    expect(store.snapshot().counts.entities).toBe(3)
    const result = store.search({ query: 'Invoicing Gateway', vector: null, scope: null, limit: 6 })
    expect(result.hits).toHaveLength(3)
    expect(
      result.hits.every((hit) => hit.reasons.includes('lexical') && hit.reasons.includes('exact')),
    ).toBe(true)
  })
  it('does not merge equal names with different kinds, and accepts existing entity ids', () => {
    const { store } = fixture()
    approve(store)
    const harbor = store.knowledge().entities.find((item) => item.label === 'Harbor')!
    const base = extraction('unused')
    approve(store, {
      jobId: 'next',
      entities: [{ key: 'harbor-team', label: 'Harbor', kind: 'team', aliases: [] }],
      memories: [
        {
          ...base.memories[0]!,
          subject: 'harbor-team',
          object: harbor.id,
          predicate: 'owns',
          summary: 'Harbor team owns Harbor.',
        },
      ],
      vectors: [vector(0, 0, 1)],
    })
    expect(store.knowledge().entities.filter((item) => item.label === 'Harbor')).toHaveLength(2)
    const latest = store.knowledge().memories[0]!
    expect(latest.objectId).toBe(harbor.id)
    expect(latest.subjectId).not.toBe(harbor.id)
  })
})
