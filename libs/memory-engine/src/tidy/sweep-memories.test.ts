import { expect, it, vi } from 'vitest'
import { fixture, vector } from '../test-support'
import { encodeVector } from '../vectors'
import { seed } from './test-support'

function memoryPair(similarity: number, shared = true) {
  const result = fixture()
  seed(result.db, 2)
  if (shared) result.db.exec('UPDATE mentions SET entity=1')
  const update = result.db.prepare('UPDATE memory_vectors SET vector=? WHERE memory=?')
  update.run(encodeVector(vector(1, 0)), 1)
  update.run(encodeVector(vector(similarity, Math.sqrt(1 - similarity ** 2))), 2)
  return result
}

it.each([0.86, 0.83, 0.8])(
  'calibrates near-repeat candidates at cosine %s without applying them',
  (similarity) => {
    const { store } = memoryPair(similarity)
    const result = store.sweep({ entityIds: [], memoryIds: ['memory-1'] })
    expect(store.suggestions('same_memory', null, 20).items).toHaveLength(
      similarity >= 0.84 ? 1 : 0,
    )
    expect(result.folded).toBe(0)
    expect(store.snapshot().counts.memories).toBe(2)
  },
)

it.each(['scope', 'branch'])('raises a cross-%s pair with review actions but no fold', (column) => {
  const { store, db } = memoryPair(0.86)
  db.prepare(`UPDATE memories SET ${column}=? WHERE n=2`).run('Kestrel')
  expect(store.sweep({ entityIds: [], memoryIds: ['memory-1'] }).folded).toBe(0)
  const items = store.suggestions('same_memory', null, 20).items
  expect(items).toHaveLength(1)
  expect(items[0]!.reason).toBe(
    `These two sentences say nearly the same thing. They come from different ${column === 'scope' ? 'projects' : 'branches'}.`,
  )
  expect(store.suggestion(items[0]!.id)?.allowed).toEqual(['dispute', 'replace'])
  expect(() =>
    store.applySuggestion(items[0]!.id, { kind: 'fold', survivorId: 'memory-1' }, store.revision()),
  ).toThrow('cannot be folded')
})

it.each(['name', 'alias', 'one-word'])(
  'finds a paraphrase through duplicate entity %s buckets without shared ids',
  (match) => {
    const { store, db } = memoryPair(0.86, false)
    if (match === 'alias') {
      db.exec(
        "UPDATE entities SET label='Mara Voss' WHERE n=2; UPDATE entity_names SET name='Mara Voss',folded='mara voss' WHERE entity=2; INSERT INTO entity_names VALUES (3,2,'Rina Okafor','rina okafor')",
      )
    } else if (match === 'one-word') {
      db.exec(
        "UPDATE entities SET label='Rina' WHERE n=1; UPDATE entity_names SET name='Rina',folded='rina' WHERE entity=1; UPDATE entity_words SET text='Rina' WHERE rowid=1",
      )
    }
    store.sweep({ entityIds: [], memoryIds: ['memory-1'] })
    const items = store.suggestions('same_memory', null, 20).items
    expect(items).toHaveLength(1)
    expect(items[0]!.reason).toBe('These two sentences say nearly the same thing.')
    expect(store.snapshot().counts.memories).toBe(2)
  },
)

function hub(count: number, partner: number) {
  const result = fixture()
  seed(result.db, count)
  result.db.exec(
    'UPDATE mentions SET entity=1; UPDATE entities SET memories=CASE WHEN n=1 THEN ' +
      count +
      ' ELSE 0 END; DELETE FROM entity_names WHERE entity>1',
  )
  result.db.prepare('UPDATE memory_vectors SET vector=?').run(encodeVector(vector(0, 1)))
  result.db
    .prepare('UPDATE memory_vectors SET vector=? WHERE memory=?')
    .run(encodeVector(vector()), count)
  result.db
    .prepare('UPDATE memory_vectors SET vector=? WHERE memory=?')
    .run(encodeVector(vector(0.86, Math.sqrt(1 - 0.86 ** 2))), partner)
  return result
}

it('finds a hub-only paraphrase whose partner is the 150th newest memory', () => {
  const { store } = hub(200, 51)
  store.sweep({ entityIds: [], memoryIds: ['memory-200'] })
  expect(
    store.suggestions('same_memory', null, 20).items.map((s) => s.subjects.map((v) => v.id).sort()),
  ).toContainEqual(['memory-200', 'memory-51'])
})

it('caps a hub at its newest 256 memories, reporting the excluded 300th-newest partner', () => {
  const { store, db } = hub(400, 101)
  db.exec(
    "UPDATE tidy_sweep SET phase='memories',cursor=399,entity_max=400,memory_max=400,started_at=1",
  )
  const result = store.sweep('all')
  expect(store.suggestions('same_memory', null, 20).items).toEqual([])
  expect(result.coverage.limitedChecks).toBeGreaterThan(0)
})

it('uses the four most specific entities rather than the first four ids', () => {
  const { store, db } = memoryPair(0.86, false)
  db.exec(
    "DELETE FROM entity_names; INSERT INTO entities(n,id,label,kind,created_at,memories) VALUES (3,'ledger-3','Ledger 3','project',1,100),(4,'ledger-4','Ledger 4','project',1,100),(5,'ledger-5','Ledger 5','project',1,2); UPDATE entities SET memories=100 WHERE n<3; DELETE FROM mentions; INSERT INTO mentions VALUES (1,1),(1,2),(1,3),(1,4),(1,5),(2,5)",
  )
  store.sweep({ entityIds: [], memoryIds: ['memory-1'] })
  expect(store.suggestions('same_memory', null, 20).items).toHaveLength(1)
})

it('raises at most eight of the best 32 candidates per memory', () => {
  const { store, db } = fixture()
  seed(db, 40)
  db.exec('UPDATE mentions SET entity=1')
  db.prepare('UPDATE memory_vectors SET vector=?').run(encodeVector(vector()))
  store.sweep({ entityIds: [], memoryIds: ['memory-40'] })
  expect(store.suggestions('same_memory', null, 50).items).toHaveLength(8)
})

it('caches a 256-memory hub window once per 128-memory chunk, not across calls', () => {
  const { store, db } = hub(256, 107)
  db.exec(
    "UPDATE tidy_sweep SET phase='memories',cursor=0,entity_max=256,memory_max=256,started_at=1",
  )
  const prepare = db.prepare.bind(db)
  let windowsRead = 0
  db.prepare = (sql) => {
    const statement = prepare(sql)
    if (sql.includes('FROM mentions WHERE entity=?') && sql.includes('memory_vectors')) {
      const all = statement.all.bind(statement)
      vi.spyOn(statement, 'all').mockImplementation((...args) => {
        windowsRead++
        return all(...args)
      })
    }
    return statement
  }
  try {
    const start = performance.now()
    const result = store.sweep('all')
    console.log(
      JSON.stringify({ hubMemories: 256, chunkMemories: 128, chunkMs: performance.now() - start }),
    )
    expect(result.coverage.memories).toBe(128)
    expect(result.suggestions).toBeLessThanOrEqual(128 * 8)
    expect(windowsRead).toBe(1)
    store.sweep('all')
    expect(windowsRead).toBe(2)
  } finally {
    vi.restoreAllMocks()
    db.prepare = prepare
  }
})

it.each(['manual', 'suggested'])(
  'a %s entity merge compares its memories again without a whole-Brain pass',
  (mode) => {
    const { store } = memoryPair(0.86, false)
    // No memory pass ran before the merge: only the merge hook can discover this pair.
    if (mode === 'manual') store.merge('rina-2', 'rina-1', store.revision())
    else {
      store.sweep({ entityIds: ['rina-1'], memoryIds: [] })
      const id = store.suggestions('same_entity', null, 20).items[0]!.id
      store.applySuggestion(id, { kind: 'merge', survivorId: 'rina-1' }, store.revision())
    }
    expect(store.suggestions('same_memory', null, 20).items).toHaveLength(1)
    expect(store.snapshot().counts.memories).toBe(2)
  },
)
