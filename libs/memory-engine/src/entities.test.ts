import { describe, expect, it } from 'vitest'
import { approve, extraction, fixture, vector } from './test-support'
import { fold, mentions, wholePhrase } from './text'

describe('Brain entity identities and indexed candidates', () => {
  it('folds unicode and preserves whole-word punctuation', () => {
    expect(fold(' ＨＡＲＢＯＲ  Service ')).toBe('harbor service')
    expect(wholePhrase('Use C++.', 'C++')).toBe(true)
    expect(mentions('Harborview', ['Harbor'])).toBe(false)
  })
  it('returns exact keys, names, word and trigram candidates without resolving by kind', () => {
    const { store } = fixture()
    const base = extraction('unused')
    base.entities[0]!.keys = [{ namespace: 'ticket', value: 'H-27' }]
    approve(store, base)
    const matches = store.entityMatches(
      [
        {
          label: 'Harbor billing service',
          aliases: [],
          keys: [{ namespace: 'ticket', value: 'H-27' }],
        },
      ],
      20,
    )[0]!
    const harbor = store.overview(300).nodes.find((item) => item.label === 'Harbor')!
    expect(
      matches.filter((item) => item.entityId === harbor.id).map((item) => item.channel),
    ).toEqual(expect.arrayContaining(['key', 'name', 'words', 'trigram']))
    expect(store.entityCards([harbor.id])[0]?.neighbours).toHaveLength(2)
  })
  it('reuse adds aliases without touching memory FTS; uncertain and same-name people create new identities', () => {
    const { store, db } = fixture()
    approve(store)
    const original = store.overview(300).nodes.find((item) => item.label === 'Harbor')!
    const before = db.prepare('SELECT rowid,summary FROM memory_words').all()
    const base = extraction('next')
    approve(store, {
      jobId: 'next',
      entities: [
        { ...base.entities[0]!, label: 'Gateway', decision: 'reuse', entityId: original.id },
      ],
      entityVectors: [vector()],
      memories: [
        {
          ...base.memories[0]!,
          entities: ['harbor'],
          links: [],
          summary: 'Daily settlement is final.',
        },
      ],
      memoryVectors: [vector()],
    })
    expect(store.entity(original.id).entity.aliases).toContain('Gateway')
    expect(db.prepare('SELECT rowid,summary FROM memory_words WHERE rowid<=2').all()).toEqual(
      before,
    )
    const tom = base.entities[2]!
    approve(store, {
      jobId: 'third',
      entities: [{ ...tom, decision: 'uncertain' }],
      entityVectors: [vector()],
      memories: [{ ...base.memories[0]!, entities: ['tom'], links: [] }],
      memoryVectors: [vector()],
    })
    expect(store.overview(300).nodes.filter((item) => item.label === 'Tom Lee')).toHaveLength(2)
  })
})
