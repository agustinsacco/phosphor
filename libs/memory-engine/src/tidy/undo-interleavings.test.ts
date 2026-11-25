import { expect, it } from 'vitest'
import { saveAndListMemories, extraction, fixture, lane, vector } from '../test-support'
import type { BrainStore, Proposal } from '../types'
import { dump, seed } from './test-support'

type Kind = 'merge' | 'fold' | 'dispute' | 'replace'
function setup() {
  const result = fixture()
  seed(result.db, 5)
  result.db.exec(`INSERT INTO mentions VALUES (1,2),(2,1),(3,1),(4,1),(5,1);
    UPDATE memories SET observed_at=100;
    INSERT INTO relations(n,memory,subject,predicate,object,live,observed_at) VALUES (1,1,1,'member_of',3,1,100);
    INSERT INTO relation_support VALUES (1,1,'Original Ledger support');`)
  return result
}
function change(store: BrainStore, kind: Kind, first = 'memory-1', second = 'memory-2'): string {
  if (kind === 'merge') return store.merge('rina-2', 'rina-1', store.revision())
  store.sweep({ entityIds: [], memoryIds: [first, second] })
  const pair = store
    .waitingSuggestions(50, 0)
    .items.find((s) => [first, second].every((id) => s.subjects.some((v) => v.id === id)))
  if (!pair) throw new Error('Expected a waiting memory pair')
  return store.resolve(
    pair.suggestionId,
    kind === 'fold'
      ? { kind, survivorId: second }
      : kind === 'replace'
        ? { kind, newerId: second }
        : { kind },
    { runId: null, reason: 'Compared the two Ledger records.' },
  )
}
function enrich(
  store: BrainStore,
  target: string,
  event: 'support' | 'mention' | 'relation' | 'quote',
) {
  const memory: Proposal['memories'][number] = {
    summary: 'Ledger independent approval',
    type: 'fact',
    kind: 'reported',
    entities: event === 'mention' ? ['rina-1', 'rina-5'] : ['rina-1', 'rina-3'],
    links:
      event === 'mention' || event === 'quote'
        ? []
        : [
            {
              subject: 'rina-1',
              predicate: event === 'support' ? 'member_of' : 'works_on',
              object: 'rina-3',
              label: event === 'support' ? 'is a member of' : 'works on',
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
  saveAndListMemories(store, {
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
/** Every knowledge row; entity counters are left out because `setup` inserts rows without them. */
function knowledge(db: Parameters<typeof dump>[0]) {
  const rows = dump(db)
  rows.entities = rows.entities!.map((row) => {
    const {
      memories: _memories,
      connections: _connections,
      ...rest
    } = row as Record<string, unknown>
    return rest
  })
  return rows
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
      // A merge refuses only a later write against the survivor on a memory it rewrote.
      if (kind === 'fold' || (kind === 'merge' && event === 'relation')) {
        expect(() => store.tidyUndo(operation, store.revision())).toThrow(
          'cannot be cleanly undone',
        )
        expect(dump(db)).toEqual(before)
      } else expect(() => store.tidyUndo(operation, store.revision())).not.toThrow()
      expect(
        store.memory(target).quotes.some((q) => q.quote === 'Independent Ledger support'),
      ).toBe(true)
      if (kind === 'merge' && event !== 'relation')
        expect(store.memory('memory-2').memory.entityIds.toSorted()).toEqual(['rina-1', 'rina-2'])
    },
  )
}
it('merge undo stays clean after a later quote on a memory it did not rewrite', () => {
  const { store, db } = setup()
  const operation = store.merge('rina-2', 'rina-1', store.revision())
  enrich(store, 'memory-3', 'quote')
  expect(() => store.tidyUndo(operation, store.revision())).not.toThrow()
  expect(store.memory('memory-1').memory.entityIds.toSorted()).toEqual(['rina-1', 'rina-2'])
  expect(store.memory('memory-2').memory.entityIds.toSorted()).toEqual(['rina-1', 'rina-2'])
  expect(store.memory('memory-3').quotes.map((q) => q.quote)).toContain(
    'Independent Ledger support',
  )
  expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
})

for (const kind of ['merge', 'fold', 'dispute', 'replace'] as const) {
  for (const later of ['merge', 'fold', 'dispute', 'replace'] as const) {
    it(`${kind} undo after later ${later} on overlapping records`, () => {
      const { store, db } = setup()
      const operation = change(store, kind)
      const target = kind === 'merge' ? 'memory-1' : 'memory-2'
      if (later === 'fold' && (kind === 'dispute' || kind === 'replace')) {
        expect(() => change(store, later, target, 'memory-3')).toThrow(/history|disputed/)
        store.tidyUndo(operation, store.revision())
        expect(store.memory('memory-1').memory.state).toBe('active')
        return
      }
      if (later === 'merge') store.merge('rina-1', 'rina-3', store.revision())
      else change(store, later, target, 'memory-3')
      const before = dump(db)
      // A replace carries memory-1's link to memory-2; a later replace carries it on again.
      const refuse =
        kind === 'merge' ||
        kind === 'fold' ||
        (kind === 'dispute' && later === 'replace') ||
        (kind === 'replace' && (later === 'merge' || later === 'replace'))
      if (refuse) {
        expect(() => store.tidyUndo(operation, store.revision())).toThrow(
          'cannot be cleanly undone',
        )
        expect(dump(db)).toEqual(before)
      } else {
        store.tidyUndo(operation, store.revision())
        expect(store.memory('memory-1').memory.state).toBe('active')
        expect(store.memory(target).memory.state).toBe(
          later === 'dispute' ? 'disputed' : later === 'replace' ? 'superseded' : 'active',
        )
      }
      expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    })
  }
  it(`${kind} undo after Forget never restores the removed memory`, () => {
    const { store, db } = setup()
    const operation = change(store, kind)
    const target = kind === 'merge' ? 'memory-1' : 'memory-2'
    store.forget(target)
    if (kind === 'merge') store.tidyUndo(operation, store.revision())
    else
      expect(() => store.tidyUndo(operation, store.revision())).toThrow(
        /forgotten|no longer available/,
      )
    expect(() => store.memory(target)).toThrow('not found')
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  })
  it(`${kind} undo after its retention pruning refuses without changing knowledge`, () => {
    const { store, db } = setup()
    const operation = change(store, kind)
    const insert = db.prepare(
      "INSERT INTO tidy_operations VALUES (?,'merge',0,'Merged two people or things',999999,NULL,NULL,'entity','old','new')",
    )
    for (let i = 0; i < 200; i++) insert.run(`retained-${i}`)
    store.merge('rina-5', 'rina-4', store.revision())
    expect(db.prepare('SELECT id FROM tidy_operations WHERE id=?').get(operation)).toBeUndefined()
    const before = dump(db)
    expect(() => store.tidyUndo(operation, store.revision())).toThrow('no longer available')
    expect(dump(db)).toEqual(before)
  })
}

it.each(['merge', 'fold', 'dispute', 'replace'] as const)(
  '%s undo after Read again is refused while the replaced lane memory is gone',
  (kind) => {
    const { store, db } = setup()
    const target = kind === 'merge' ? 'memory-1' : 'memory-2'
    const sessionId = kind === 'merge' ? 'lane-1' : 'lane-2'
    db.prepare('UPDATE evidence SET session_id=?').run(sessionId)
    const old = store.enqueue(lane({ sessionId }), 'queued')
    store.updateJob(old.id, { state: 'done' })
    const operation = change(store, kind)
    const next = store.enqueue(
      lane({ sessionId, replaces: old.id, leafId: 'replacement-leaf' }),
      'queued',
    )
    store.updateJob(next.id, { state: 'running' })
    store.saveRead(
      extraction(next.id, {
        computedRevision: store.knowledgeRevision(),
        origin: { sessionId, title: 'Harbor planning' },
      }),
    )
    expect(() => store.memory(target)).toThrow('not found')
    // Read again keeps the earlier record, so the change cannot half-undo around the gap.
    expect(() => store.tidyUndo(operation, store.revision())).toThrow('Later changes')
    expect(() => store.memory(target)).toThrow('not found')
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  },
)

it('undoing both overlapping disputes in forward order leaves no stranded disputed state', () => {
  const { store } = setup()
  const first = change(store, 'dispute')
  const second = change(store, 'dispute', 'memory-2', 'memory-3')
  store.tidyUndo(first, store.revision())
  store.tidyUndo(second, store.revision())
  for (const id of ['memory-1', 'memory-2', 'memory-3']) {
    expect(store.memory(id).memory.state).toBe('active')
    expect(store.memory(id).related).toEqual([])
  }
})

for (const kind of ['merge', 'fold', 'dispute', 'replace'] as const) {
  it(`${kind} undo stays clean after a later approval that touches none of its records`, () => {
    const { store, db } = setup()
    const operation = change(store, kind)
    saveAndListMemories(store, { origin: { sessionId: 'kestrel-lane', title: 'Kestrel' } })
    const learned = store.snapshot().counts.memories
    store.tidyUndo(operation, store.revision())
    expect(store.snapshot().counts.memories).toBe(
      learned + (kind === 'fold' || kind === 'replace' ? 1 : 0),
    )
    expect(store.memory('memory-1').memory.state).toBe('active')
    expect(store.memory('memory-2').memory.state).toBe('active')
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  })
  for (const later of ['merge', 'fold', 'dispute', 'replace'] as const) {
    it(`${kind} then ${later}, undone newest first, restores the knowledge exactly`, () => {
      const { store, db } = setup()
      const original = knowledge(db)
      const operation = change(store, kind)
      const target = kind === 'merge' ? 'memory-1' : 'memory-2'
      if (later === 'fold' && (kind === 'dispute' || kind === 'replace')) return
      const second =
        later === 'merge'
          ? store.merge('rina-1', 'rina-3', store.revision())
          : change(store, later, target, 'memory-3')
      store.tidyUndo(second, store.revision())
      store.tidyUndo(operation, store.revision())
      expect(knowledge(db)).toEqual(original)
    })
  }
}
