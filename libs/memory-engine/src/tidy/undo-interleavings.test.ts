import { expect, it } from 'vitest'
import { approve, fixture, vector } from '../test-support'
import type { BrainStore, Proposal } from '../types'
import { dump, seed } from './test-support'

type Kind = 'merge' | 'fold' | 'dispute' | 'replace'
function setup() {
  const result = fixture()
  seed(result.db, 5)
  result.db.exec(`INSERT INTO mentions VALUES (1,2),(2,1),(3,1),(4,1),(5,1);
    UPDATE memories SET observed_at=100;
    INSERT INTO relations VALUES (1,1,1,'member_of',3,1,100);
    INSERT INTO relation_support VALUES (1,1,'Original Ledger support');`)
  return result
}
function change(store: BrainStore, kind: Kind, first = 'memory-1', second = 'memory-2'): string {
  if (kind === 'merge') return store.merge('rina-2', 'rina-1', store.revision())
  store.sweep({ entityIds: [], memoryIds: [first, second] })
  const pair = store
    .tidy(null, null, 50)
    .items.find((s) => [first, second].every((id) => s.subjects.some((v) => v.id === id)))!
  return store.tidyApply(
    pair.id,
    kind === 'fold'
      ? { kind, survivorId: second }
      : kind === 'replace'
        ? { kind, newerId: second }
        : { kind },
    store.revision(),
  )!
}
function enrich(store: BrainStore, target: string, event: 'support' | 'mention' | 'relation') {
  const memory: Proposal['memories'][number] = {
    summary: 'Ledger independent approval',
    type: 'fact',
    kind: 'reported',
    entities: event === 'mention' ? ['rina-1', 'rina-5'] : ['rina-1', 'rina-3'],
    links:
      event === 'mention'
        ? []
        : [
            {
              subject: 'rina-1',
              predicate: event === 'support' ? 'member_of' : 'works_on',
              object: 'rina-3',
              citation: { evidence: 0, quote: 'Independent Ledger support' },
            },
          ],
    branch: false,
    validFrom: null,
    validTo: null,
    action: 'enrich',
    target,
    reason: '',
    citations: [{ evidence: 0, quote: 'Independent Ledger support' }],
  }
  approve(store, {
    entities: [],
    entityVectors: [],
    memories: [memory],
    memoryVectors: [vector()],
    evidence: [
      {
        sessionId: 'independent-lane',
        entryId: 'independent-entry',
        role: 'user',
        label: 'Ledger',
        observedAt: 1,
        text: 'Independent Ledger support',
      },
    ],
  })
}
it('fold undo never cascades away later independent support with an older evidence date', () => {
  const { store, db } = setup()
  const operation = change(store, 'fold')
  enrich(store, 'memory-2', 'support')
  const before = dump(db)
  expect(() => store.tidyUndo(operation, store.revision())).toThrow('cannot be cleanly undone')
  expect(dump(db)).toEqual(before)
  expect(store.memory('memory-2').linkQuotes).toEqual(
    expect.objectContaining({
      [store.memory('memory-2').memory.links[0]!.id]: expect.arrayContaining([
        expect.objectContaining({ quote: 'Independent Ledger support' }),
      ]),
    }),
  )
})
it('undoing A/B dispute keeps B disputed by its later B/C conflict', () => {
  const { store } = setup()
  const first = change(store, 'dispute')
  change(store, 'dispute', 'memory-2', 'memory-3')
  store.tidyUndo(first, store.revision())
  expect(store.memory('memory-1').memory.state).toBe('active')
  expect(store.memory('memory-2').memory.state).toBe('disputed')
  expect(store.memory('memory-3').memory.state).toBe('disputed')
  expect(store.memory('memory-2').related.map((r) => r.memory.id)).toEqual(['memory-3'])
})
for (const kind of ['merge', 'fold', 'dispute', 'replace'] as const) {
  it.each(['support', 'mention', 'relation'] as const)(
    `${kind} undo preserves later approval %s or refuses atomically`,
    (event) => {
      const { store, db } = setup()
      const operation = change(store, kind)
      const target = kind === 'merge' ? 'memory-1' : 'memory-2'
      enrich(store, target, event)
      const before = dump(db)
      if (kind === 'merge' || kind === 'fold') {
        expect(() => store.tidyUndo(operation, store.revision())).toThrow(
          'cannot be cleanly undone',
        )
        expect(dump(db)).toEqual(before)
      } else store.tidyUndo(operation, store.revision())
      expect(
        store.memory(target).quotes.some((q) => q.quote === 'Independent Ledger support'),
      ).toBe(true)
    },
  )
}
