import { expect, it, vi } from 'vitest'
import { saveAndListMemories, extraction, fixture, vector } from '../test-support'

function repeated() {
  const data = extraction('invented')
  const first = data.memories[0]!
  return { ...data, memories: [first, { ...first }], memoryVectors: [vector(), vector()] }
}
it('sweeps exact repeats only after approval commits, with an automatic undo operation', () => {
  const { store } = fixture()
  saveAndListMemories(store, repeated())
  expect(store.snapshot().counts.memories).toBe(1)
  expect(store.tidySummary().automaticFolds).toBe(1)
  expect(store.tidyChanges(20).items[0]).toMatchObject({ kind: 'fold', who: 'automatic' })
})
it('never reports a saved approval as failed when its post-commit sweep fails, and can retry', () => {
  const { store, db } = fixture()
  const warning = vi.spyOn(process, 'emitWarning').mockImplementation(() => {})
  const prepare = db.prepare.bind(db)
  let fail = true
  db.prepare = (sql) => {
    if (fail && sql.includes('tidy_memory_keys')) {
      fail = false
      throw new Error('Invented sweep failure')
    }
    return prepare(sql)
  }
  try {
    expect(() => saveAndListMemories(store, repeated())).not.toThrow()
    expect(store.snapshot().counts.memories).toBe(2)
    expect(warning).toHaveBeenCalled()
    store.sweep('all')
    store.sweep('all')
    expect(store.snapshot().counts.memories).toBe(1)
  } finally {
    warning.mockRestore()
    db.prepare = prepare
  }
})
it('entity merges sweep changed mention sets, which can expose an exact memory repeat', () => {
  const { store } = fixture()
  const data = repeated()
  data.memories = [data.memories[0]!]
  data.memoryVectors = [vector()]
  saveAndListMemories(store, data)
  data.computedRevision = store.revision()
  saveAndListMemories(store, { ...data, origin: { sessionId: 'ledger', title: 'Ledger' } })
  const people = store.overview(20).nodes.filter((e) => e.kind === 'person')
  const projects = store.overview(20).nodes.filter((e) => e.kind === 'component')
  store.merge(people[1]!.id, people[0]!.id, store.revision())
  expect(store.snapshot().counts.memories).toBe(2)
  store.merge(projects[1]!.id, projects[0]!.id, store.revision())
  expect(store.snapshot().counts.memories).toBe(1)
  expect(store.tidySummary().automaticFolds).toBe(1)
})
