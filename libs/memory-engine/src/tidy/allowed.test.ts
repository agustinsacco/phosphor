import { expect, it } from 'vitest'
import { fixture } from '../test-support'
import { seed, seedHistoricalVerdict } from './test-support'

function pair(kind: 'same_entity' | 'same_memory' | 'conflict' = 'same_memory') {
  const result = fixture()
  seed(result.db, 2)
  if (kind !== 'same_entity') result.db.exec('UPDATE mentions SET entity=1')
  result.store.sweep({
    entityIds: kind === 'same_entity' ? ['rina-1'] : [],
    memoryIds: kind === 'same_entity' ? [] : ['memory-1'],
  })
  const id = result.store.suggestions(null, null, 20).items[0]!.id
  if (kind === 'conflict')
    seedHistoricalVerdict(result.db, id, { kind: 'conflict', reason: 'They disagree.' })
  return { ...result, id }
}

it('offers merge for entities and no actions after settlement or a missing subject', () => {
  const { store, db, id } = pair('same_entity')
  expect(store.suggestion(id)).toMatchObject({ allowed: ['merge'], foldRefusal: null })
  db.exec("UPDATE tidy_suggestions SET second_id='missing'")
  expect(store.suggestion(id)).toMatchObject({ allowed: [], foldRefusal: null })
  const settled = pair('same_entity')
  settled.store.dismissSuggestion(settled.id, settled.store.revision())
  expect(settled.store.suggestion(settled.id)).toMatchObject({ allowed: [], foldRefusal: null })
})

it.each(['same_memory', 'conflict'] as const)(
  'offers all memory actions for %s with matching applicability',
  (kind) => {
    const { store, id } = pair(kind)
    expect(store.suggestion(id)).toMatchObject({
      allowed: ['fold', 'dispute', 'replace'],
      foldRefusal: null,
    })
    const operation = store.applySuggestion(
      id,
      { kind: 'fold', survivorId: 'memory-1' },
      store.revision(),
    )
    expect(operation).toBeTruthy()
    expect(store.suggestion(id)).toMatchObject({ allowed: [], foldRefusal: null })
  },
)

it.each(['scope', 'branch', 'valid_from', 'valid_to'])(
  'refuses fold for different %s while accepting dispute',
  (column) => {
    const { store, db, id } = pair()
    db.prepare(`UPDATE memories SET ${column}=? WHERE n=2`).run(
      column.startsWith('valid') ? 20 : 'Kestrel',
    )
    expect(store.suggestion(id)).toMatchObject({
      allowed: ['dispute', 'replace'],
      foldRefusal: 'applicability',
    })
    expect(() =>
      store.applySuggestion(id, { kind: 'fold', survivorId: 'memory-1' }, store.revision()),
    ).toThrow('different scope, branch or validity dates')
    expect(store.applySuggestion(id, { kind: 'dispute' }, store.revision())).toBeTruthy()
    expect(store.memory('memory-1').memory.state).toBe('disputed')
  },
)

it('accepts replacement on a same-memory suggestion, without requiring a model verdict', () => {
  const { store, id } = pair()
  expect(
    store.applySuggestion(id, { kind: 'replace', newerId: 'memory-2' }, store.revision()),
  ).toBeTruthy()
  expect(store.memory('memory-1').memory.state).toBe('superseded')
})

it.each(['disputed', 'history', 'linked-dispute', 'superseded'])(
  'uses the same history/state guards for listing and applying: %s',
  (condition) => {
    const { store, db, id } = pair()
    if (condition === 'history' || condition === 'linked-dispute') {
      db.exec("INSERT INTO memory_links VALUES (2,1,'conflicts',10)")
    }
    if (condition !== 'history')
      db.prepare('UPDATE memories SET state=? WHERE n=1').run(
        condition === 'superseded' ? 'superseded' : 'disputed',
      )
    const allowed =
      condition === 'superseded'
        ? []
        : condition === 'history' || condition === 'linked-dispute'
          ? ['replace']
          : ['dispute', 'replace']
    expect(store.suggestion(id)).toMatchObject({ allowed, foldRefusal: 'history' })
    expect(() =>
      store.applySuggestion(id, { kind: 'fold', survivorId: 'memory-1' }, store.revision()),
    ).toThrow()
    if (!allowed.includes('dispute'))
      expect(() => store.applySuggestion(id, { kind: 'dispute' }, store.revision())).toThrow()
    if (!allowed.includes('replace'))
      expect(() =>
        store.applySuggestion(id, { kind: 'replace', newerId: 'memory-2' }, store.revision()),
      ).toThrow()
  },
)

it('offers forget and keep for a flag, and rejects unrelated actions without mutation', () => {
  const { store, db } = fixture()
  seed(db, 1)
  const id = store.flag({
    memoryId: 'memory-1',
    problem: 'wrong',
    reason: 'Verified correction.',
    sessionId: 'harbor',
    title: 'Harbor',
  }).suggestionId!
  expect(store.suggestion(id)).toMatchObject({ allowed: ['forget', 'keep'], foldRefusal: null })
  const revision = store.revision()
  expect(() => store.applySuggestion(id, { kind: 'dispute' }, revision)).toThrow(
    'This action does not apply',
  )
  expect(store.revision()).toBe(revision)
  store.applySuggestion(id, { kind: 'keep' }, revision)
  expect(store.suggestion(id)).toMatchObject({ allowed: [], foldRefusal: null })
})
