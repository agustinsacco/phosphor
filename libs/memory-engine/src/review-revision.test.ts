import { expect, it } from 'vitest'
import { extraction, fixture, lane } from './test-support'
import { seed } from './tidy/test-support'

const keep = { memories: [], identities: {}, groups: [], descriptions: [], confirmations: [] }
function pending() {
  const s = fixture()
  seed(s.db, 3)
  const job = s.store.enqueue(lane(), 'queued')
  s.store.propose(extraction(job.id))
  return { ...s, job }
}
it.each(['suggestions', 'dismissal', 'flag', 'keep'] as const)(
  'does not stale a review for Tidy %s bookkeeping',
  (kind) => {
    const { store, job } = pending()
    if (kind === 'flag' || kind === 'keep') {
      const flag = store.flag({
        memoryId: 'memory-1',
        sessionId: 'ledger-lane',
        title: 'Ledger',
        problem: 'wrong',
        reason: 'Rina corrected this.',
      })
      if (kind === 'keep')
        store.applySuggestion(flag.suggestionId!, { kind: 'keep' }, store.revision())
    } else {
      store.sweep('all')
      const pair = store.suggestions(null, null, 1).items[0]!
      if (kind === 'dismissal') store.dismissSuggestion(pair.id, store.revision())
    }
    expect(store.revision()).toBeGreaterThan(0)
    expect(() => store.review(job.id, keep, 0)).not.toThrow()
  },
)
it.each(['describe', 'removeName', 'split', 'merge', 'forget'] as const)(
  'stales reviews when %s changes knowledge',
  (kind) => {
    const { store, db, job } = pending()
    if (kind === 'describe') store.describe('rina-1', 'Harbor lead', store.revision())
    if (kind === 'removeName') {
      db.exec("INSERT INTO entity_names(entity,name,folded) VALUES (1,'Rina','rina')")
      store.removeName('rina-1', 'Rina', store.revision())
    }
    if (kind === 'split') {
      db.exec('INSERT INTO mentions VALUES (2,1); UPDATE entities SET memories=2 WHERE n=1')
      store.split('rina-1', ['memory-2'], { label: 'Mara Voss', kind: 'person' }, store.revision())
    }
    if (kind === 'merge') store.merge('rina-2', 'rina-1', store.revision())
    if (kind === 'forget') store.forget('memory-1')
    expect(() => store.review(job.id, keep, 0)).toThrow('Brain changed while you were reviewing')
  },
)

it.each(['fold', 'dispute', 'replace'] as const)(
  'stales reviews for a Tidy %s and its undo',
  (kind) => {
    const { store, db, job } = pending()
    db.exec('INSERT INTO mentions VALUES (1,2),(2,1)')
    store.sweep({ entityIds: [], memoryIds: ['memory-1', 'memory-2'] })
    const pair = store.suggestions('same_memory', null, 20).items[0]!
    const operation = store.applySuggestion(
      pair.id,
      kind === 'fold'
        ? { kind, survivorId: pair.subjects[0]!.id }
        : kind === 'replace'
          ? { kind, newerId: pair.subjects[0]!.id }
          : { kind },
      store.revision(),
    )!
    expect(() => store.review(job.id, keep, 0)).toThrow('Brain changed while you were reviewing')
    const knowledge = store.knowledgeRevision()
    store.tidyUndo(operation, store.revision())
    expect(store.knowledgeRevision()).toBeGreaterThan(knowledge)
  },
)
it('finds an old revision-prefixed answer by its prompt part name in SQLite', () => {
  const { store, job } = pending()
  store.savePart(job.id, {
    part: 'answer:identity:harbor-hash',
    inputHash: '12:harbor-hash',
    output: 'cached',
  })
  expect(store.part(job.id, 'answer:identity:harbor-hash')?.output).toBe('cached')
  expect(store.part(job.id, 'answer:identity:harbor-hash', 'wrong')).toBeUndefined()
})
