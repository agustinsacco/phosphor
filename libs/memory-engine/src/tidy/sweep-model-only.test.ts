import { expect, it } from 'vitest'
import { fixture, vector } from '../test-support'
import { encodeVector } from '../vectors'
import { seed } from './test-support'
import { MODEL_ONLY_PER_CHUNK } from './sweep-memories'

/** Two seeded memories from lanes 1 and 2, at the given similarity, sharing `shared` entities. */
function pair(similarity: number, shared = 2, patch = '') {
  const result = fixture()
  seed(result.db, 2)
  result.db.exec('UPDATE mentions SET entity=1')
  if (shared > 1) result.db.exec('INSERT INTO mentions VALUES (1,2),(2,2)')
  if (patch) result.db.exec(patch)
  const update = result.db.prepare('UPDATE memory_vectors SET vector=? WHERE memory=?')
  update.run(encodeVector(vector(1, 0)), 1)
  update.run(encodeVector(vector(similarity, Math.sqrt(1 - similarity ** 2))), 2)
  result.store.sweep({ entityIds: [], memoryIds: ['memory-1'] })
  return result
}
const pending = (store: ReturnType<typeof fixture>['store']) =>
  store
    .waitingSuggestions(40, 40)
    .items.map((p) => (p.kind !== 'read' ? p.subjects.map((s) => s.id) : []))

it('queues a cross-lane disagreement only for Brain Agent, never on the page', () => {
  const { store } = pair(0.65)
  const page = store.suggestions(null, null, 20)
  expect(page.items).toEqual([])
  expect(page.counts).toEqual({ same_entity: 0, same_memory: 0, conflict: 0, flagged: 0 })
  expect(store.waitingCounts()).toEqual({
    reads: 0,
    entities: 0,
    repeats: 0,
    conflicts: 0,
    flags: 0,
  })
  expect(pending(store)).toEqual([['memory-1', 'memory-2']])
})

it.each([
  ['one shared entity', 0.65, 1, ''],
  ['the same lane and project', 0.65, 2, "UPDATE memories SET origin_session='lane-1'"],
  ['an open question', 0.65, 2, "UPDATE memories SET type='open'"],
  ['different types', 0.65, 2, "UPDATE memories SET type='decision' WHERE n=2"],
  ['a topic match', 0.55, 2, ''],
])('does not queue a pair with %s', (_, similarity, shared, patch) => {
  const { store } = pair(similarity, shared, patch)
  expect(pending(store)).toEqual([])
})

it('queues a looser paraphrase in the same lane for Brain Agent', () => {
  const { store } = pair(0.8, 2, "UPDATE memories SET origin_session='lane-1',type='open'")
  expect(store.suggestions(null, null, 20).items).toEqual([])
  expect(pending(store)).toEqual([['memory-1', 'memory-2']])
})

it('checks every visible suggestion before any hidden pair', () => {
  const { store, db } = pair(0.65)
  db.prepare(
    "INSERT INTO tidy_suggestions(id,pair_key,kind,source,state,subject_type,first_id,second_id,reason,created_at,updated_at) VALUES ('visible','memory:visible','same_memory','sweep','open','memory','memory-1','memory-2','These two sentences say nearly the same thing.',?,?)",
  ).run(Date.now() + 1000, Date.now() + 1000)
  expect(
    store.waitingSuggestions(1, 40).items.map((p) => (p.kind !== 'read' ? p.suggestionId : '')),
  ).toEqual(['visible'])
  expect(
    store.waitingSuggestions(2, 40).items.map((p) => (p.kind !== 'read' ? p.suggestionId : '')),
  ).toHaveLength(2)
})

it('bounds the pairs one sweep queues and counts the rest as cut short', () => {
  const { store, db } = fixture()
  const count = MODEL_ONLY_PER_CHUNK + 4
  seed(db, count)
  db.exec('UPDATE mentions SET entity=1; INSERT INTO mentions SELECT n,2 FROM memories')
  // Every memory scores 0.65 against memory-1 and below 0.6 against the others.
  const update = db.prepare('UPDATE memory_vectors SET vector=? WHERE memory=?')
  update.run(encodeVector(vector(1, 0, 0)), 1)
  for (let n = 2; n <= count; n++) {
    const v = new Float32Array(768)
    v[0] = 0.65
    v[n + 1] = Math.sqrt(1 - 0.65 ** 2)
    update.run(encodeVector(v), n)
  }
  const ids = Array.from({ length: count }, (_, i) => `memory-${i + 1}`)
  const result = store.sweep({ entityIds: [], memoryIds: ids })
  const queued = db
    .prepare("SELECT COUNT(*) AS n FROM tidy_suggestions WHERE kind='unchecked'")
    .get() as { n: number }
  expect(queued.n).toBe(MODEL_ONLY_PER_CHUNK)
  expect(result.suggestions).toBe(0)
  expect(result.coverage.limitedChecks).toBeGreaterThan(0)
})
