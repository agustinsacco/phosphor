import { expect, it } from 'vitest'
import { fixture } from '../test-support'
import { seed } from './test-support'

it('returns typed flag statuses without revisions for refusals, remembering each lane forever', () => {
  const { store, db } = fixture()
  seed(db, 8)
  const flag = (memoryId: string, sessionId = 'harbor') =>
    store.flag({
      memoryId,
      sessionId,
      title: 'Harbor',
      problem: 'wrong',
      reason: 'Verified facts contradict this memory.',
    })
  expect(flag('gone')).toEqual({ status: 'unavailable', suggestionId: null })
  db.exec("UPDATE memories SET state='superseded' WHERE n=8")
  expect(flag('memory-8')).toEqual({ status: 'unavailable', suggestionId: null })
  expect(store.revision()).toBe(0)
  const first = flag('memory-1')
  expect(first.status).toBe('filed')
  const revision = store.revision()
  expect(flag('memory-1', 'ledger')).toEqual({
    status: 'already_flagged',
    suggestionId: first.suggestionId,
  })
  expect(store.revision()).toBe(revision)
  store.applySuggestion(first.suggestionId!, { kind: 'keep' }, store.revision())
  expect(flag('memory-1')).toEqual({ status: 'already_flagged', suggestionId: first.suggestionId })
  expect(flag('memory-1', 'ledger').status).toBe('filed')
  for (let n = 2; n <= 6; n++) expect(flag(`memory-${n}`).status).toBe('filed')
  const cappedRevision = store.revision()
  expect(flag('memory-7')).toEqual({ status: 'limit', suggestionId: null })
  expect(store.revision()).toBe(cappedRevision)
})

it('accepted merges dismiss their pair on undo; missing subjects close and unknown kinds are skipped', () => {
  const { store, db } = fixture()
  seed(db, 2)
  store.sweep('all')
  const suggestion = store.suggestions('same_entity', null, 20).items[0]!
  const operation = store.applySuggestion(
    suggestion.id,
    { kind: 'merge', survivorId: 'rina-1' },
    store.revision(),
  )!
  store.tidyUndo(operation, store.revision())
  store.sweep({ entityIds: ['rina-1', 'rina-2'], memoryIds: [] })
  expect(store.suggestions('same_entity', null, 20).items).toEqual([])
  const flag = store.flag({
    memoryId: 'memory-1',
    sessionId: 'harbor',
    title: 'Harbor',
    reason: 'Verified correction.',
    problem: 'outdated',
  })
  db.prepare("UPDATE tidy_suggestions SET kind='future_kind' WHERE id=?").run(flag.suggestionId)
  expect(store.suggestions('flagged', null, 20).items).toEqual([])
  db.prepare("UPDATE tidy_suggestions SET kind='flagged' WHERE id=?").run(flag.suggestionId)
  db.exec('DELETE FROM memory_words WHERE rowid=1; DELETE FROM memories WHERE n=1')
  expect(store.suggestions(null, null, 20).items).toEqual([])
  expect(
    db.prepare('SELECT state FROM tidy_suggestions WHERE id=?').get(flag.suggestionId),
  ).toEqual({ state: 'cleared' })
})
it('Forget and Reset erase forgotten text from every tidy text column but ids may remain', () => {
  const { store, db } = fixture()
  seed(db, 2, true)
  db.exec(
    "UPDATE mentions SET entity=1; UPDATE entities SET memories=CASE WHEN n=1 THEN 2 ELSE 0 END; UPDATE memories SET summary='Ledger erasure sentinel'; UPDATE evidence SET text='Ledger erasure sentinel'; UPDATE citations SET quote='Ledger erasure sentinel';",
  )
  const result = store.sweep({ entityIds: [], memoryIds: ['memory-1', 'memory-2'] })
  expect(result.folded).toBe(1)
  store.flag({
    memoryId: 'memory-1',
    sessionId: 'harbor',
    title: 'Harbor',
    reason: 'Ledger erasure sentinel is wrong.',
    problem: 'wrong',
  })
  store.forget('memory-1')
  const text = () =>
    db
      .prepare("SELECT name FROM pragma_table_list WHERE name LIKE 'tidy_%' AND type='table'")
      .all()
      .flatMap((t) => db.prepare(`SELECT * FROM ${String(t.name)}`).all())
      .map((r) => JSON.stringify(r))
      .join('\n')
  expect(text()).not.toContain('Ledger erasure sentinel')
  expect(
    db
      .prepare('SELECT first_id,second_id FROM tidy_operations WHERE id=?')
      .get(result.operationIds[0]!),
  ).toEqual({ first_id: 'memory-2', second_id: 'memory-1' })
  expect(() => store.tidyUndo(result.operationIds[0]!, store.revision())).toThrow(
    'no longer available',
  )
  // Source ids contain no forgotten text; the schema permits them on retained merge records.
  expect(db.prepare('SELECT * FROM evidence').all()).toEqual([])
  store.reset()
  expect(text()).not.toContain('memory-1')
  expect(store.tidyChanges(50).items).toEqual([])
})

it('Forget erases a journaled entity description that repeats the forgotten sentence', () => {
  const { store, db } = fixture()
  seed(db, 2)
  db.exec(
    "UPDATE entities SET description='Ledger description erasure sentinel' WHERE n=2; UPDATE memories SET summary='Ledger description erasure sentinel' WHERE n=2",
  )
  store.merge('rina-2', 'rina-1', store.revision())
  store.forget('memory-2')
  const text = db
    .prepare("SELECT name FROM pragma_table_list WHERE name LIKE 'tidy_%' AND type='table'")
    .all()
    .flatMap((t) => db.prepare(`SELECT * FROM ${String(t.name)}`).all())
    .map((r) => JSON.stringify(r))
    .join('\n')
  expect(text).not.toContain('Ledger description erasure sentinel')
})

it('reads open and settled suggestions with only surviving subjects, or null after removal', () => {
  const { store, db } = fixture()
  seed(db, 2)
  store.sweep('all')
  const id = store.suggestions('same_entity', null, 20).items[0]!.id
  expect(store.suggestion(id)).toMatchObject({ suggestion: { state: 'open' } })
  expect(store.suggestion(id)?.subjects).toHaveLength(2)
  store.applySuggestion(id, { kind: 'merge', survivorId: 'rina-1' }, store.revision())
  expect(store.suggestion(id)).toMatchObject({ suggestion: { state: 'applied' } })
  expect(store.suggestion(id)?.subjects).toHaveLength(1)
  const flag = store.flag({
    memoryId: 'memory-1',
    sessionId: 'harbor',
    title: 'Harbor',
    problem: 'wrong',
    reason: 'Verified correction.',
  })
  store.dismissSuggestion(flag.suggestionId!, store.revision())
  expect(store.suggestion(flag.suggestionId!)).toMatchObject({
    suggestion: { state: 'dismissed' },
  })
  store.forget('memory-1')
  expect(store.suggestion(flag.suggestionId!)).toBeNull()
  store.reset()
  expect(store.suggestion(id)).toBeNull()
  expect(store.suggestion('missing')).toBeNull()
})

it('caps open flags at fifty even when every caller claims a different lane', () => {
  const { store, db } = fixture()
  seed(db, 51)
  const flag = (n: number) =>
    store.flag({
      memoryId: `memory-${n}`,
      sessionId: `claimed-lane-${n}`,
      title: 'Harbor review',
      problem: 'wrong',
      reason: 'The lane verified a different policy.',
    })
  for (let n = 1; n <= 50; n++) expect(flag(n).status).toBe('filed')
  const revision = store.revision()
  expect(flag(51).status).toBe('limit')
  expect(store.revision()).toBe(revision)
  expect(store.suggestions('flagged', null, 50).items).toHaveLength(50)
  store.dismissSuggestion(store.suggestions('flagged', null, 50).items[0]!.id, revision)
  expect(flag(51).status).toBe('filed')
})

it('pages suggestions without repeats', () => {
  const { store, db } = fixture()
  seed(db, 4)
  store.sweep('all')
  const page = store.suggestions('same_entity', null, 1)
  expect(page.items).toHaveLength(1)
  expect(page.next).not.toBeNull()
  expect(store.suggestions('same_entity', page.next, 1).items[0]?.id).not.toBe(page.items[0]?.id)
})
