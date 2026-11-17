import { afterEach, expect, it, vi } from 'vitest'
import type { DatabaseSync } from 'node:sqlite'
import { encodeBits } from '../bits'
import { encodeVector } from '../vectors'
import { approve, extraction, fixture } from '../test-support'
import { seed } from './test-support'

/** A sparse vector per memory so the hub raises no near repeats; only the planted pair matches. */
function spread(n: number): Float32Array {
  const result = new Float32Array(768)
  result[n % 768] = 1
  result[(n * 7 + 3) % 768] = 1
  return result
}
/** Entities 1 and 2 are two "Rina Okafor" records; the hub's memories all mention entity 1. */
function hub(db: DatabaseSync, size: number): void {
  seed(db, 2)
  const memory = db.prepare('INSERT INTO memories VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
  const mention = db.prepare('INSERT INTO mentions VALUES (?,?)')
  const vectors = db.prepare('INSERT INTO memory_vectors VALUES (?,?)')
  const bits = db.prepare('INSERT INTO memory_bits VALUES (?,?)')
  const words = db.prepare('INSERT INTO memory_words(rowid,summary) VALUES (?,?)')
  db.exec('BEGIN')
  for (let i = 1; i <= size; i++) {
    const n = i + 2
    // The last two become exact repeats once entity 2 is merged into entity 1.
    const planted = i > size - 2
    const summary = planted ? 'Rina reviews Kestrel releases.' : `Rina reviews Harbor change ${i}.`
    memory.run(
      n,
      `hub-${String(i).padStart(5, '0')}`,
      summary,
      'fact',
      'reported',
      '/Harbor',
      null,
      null,
      null,
      n,
      n,
      'active',
      `lane-${n}`,
      'Ledger',
      null,
    )
    mention.run(n, planted && i === size ? 2 : 1)
    vectors.run(n, encodeVector(spread(n)))
    bits.run(n, encodeBits(spread(n)))
    words.run(n, summary)
  }
  db.exec('COMMIT')
  db.prepare("UPDATE meta SET value=? WHERE key='memories'").run(String(size + 2))
}
/** Counts per-memory sweeps: each one reads its memory row through this statement exactly once. */
function countSweeps(db: DatabaseSync): () => number {
  const prepare = db.prepare.bind(db)
  let swept = 0
  db.prepare = (sql) => {
    const statement = prepare(sql)
    if (sql === 'SELECT id,scope,branch,state FROM memories WHERE n=?') {
      const get = statement.get.bind(statement)
      vi.spyOn(statement, 'get').mockImplementation((...args) => {
        swept++
        return get(...args)
      })
    }
    return statement
  }
  return () => swept
}
afterEach(() => {
  vi.restoreAllMocks()
})
function fingerprints(db: DatabaseSync): number {
  return Number(db.prepare('SELECT COUNT(*) AS n FROM tidy_memory_keys').get()!.n)
}

it('a merge sweeps every touched memory of a small hub inside the mutation', () => {
  const { store, db } = fixture()
  hub(db, 100)
  const swept = countSweeps(db)
  store.merge('rina-2', 'rina-1', store.revision())
  expect(swept()).toBe(102)
  expect(store.tidySummary().automaticFolds).toBe(1)
})

it('a 2,100-memory hub merge sweeps no more than a 128-memory one inside the mutation', () => {
  const { store, db } = fixture()
  hub(db, 2100)
  const swept = countSweeps(db)
  store.merge('rina-2', 'rina-1', store.revision())
  expect(swept()).toBe(128)
  // The rest wait without fingerprints, so neither an approval nor a pass compares stale keys.
  expect(fingerprints(db)).toBe(128)
  expect(store.tidySummary().automaticFolds).toBe(0)
})

it('an approval that adds 200 memories sweeps at most 128 of them inside the mutation', () => {
  const { store, db } = fixture()
  const base = extraction('invented').memories[0]!
  const memories = Array.from({ length: 200 }, (_, i) => ({
    ...base,
    summary: `Rina Okafor reviews Harbor change ${i}.`,
    links: [],
  }))
  const swept = countSweeps(db)
  approve(store, { memories, memoryVectors: memories.map((_, i) => spread(i)) })
  expect(store.snapshot().counts.memories).toBe(200)
  expect(swept()).toBe(128)
})
