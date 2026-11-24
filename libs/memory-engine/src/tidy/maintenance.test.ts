import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { openBrainStore } from '../store'
import { saveAndListMemories, extraction, fixture } from '../test-support'
import { hub, spread } from './test-support'

/** Counts per-memory sweeps: each one reads its memory row through this statement exactly once. */
function countSweeps(db: DatabaseSync): () => number {
  const prepare = db.prepare.bind(db)
  let swept = 0
  db.prepare = (sql) => {
    const statement = prepare(sql)
    if (
      sql ===
      'SELECT id,type,summary,scope,branch,origin_session AS lane,state FROM memories WHERE n=?'
    ) {
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
  saveAndListMemories(store, { memories, memoryVectors: memories.map((_, i) => spread(i)) })
  expect(store.snapshot().counts.memories).toBe(200)
  expect(swept()).toBe(128)
  expect(store.takeTidyMaintenance()).toHaveLength(72)
})

it('hands the deferred hub memories over once, and batches of 128 finish the maintenance', () => {
  const { store, db } = fixture()
  hub(db, 2100)
  const swept = countSweeps(db)
  store.merge('rina-2', 'rina-1', store.revision())
  const rest = store.takeTidyMaintenance()
  expect(rest).toHaveLength(2102 - 128)
  expect(store.takeTidyMaintenance()).toEqual([])
  while (rest.length) store.sweep({ entityIds: [], memoryIds: rest.splice(0, 128) })
  expect(swept()).toBe(2102)
  expect(fingerprints(db)).toBe(2101)
  expect(store.tidySummary().automaticFolds).toBe(1)
})

it('drops deferred ids from before a reset', () => {
  const { store, db } = fixture()
  hub(db, 300)
  store.merge('rina-2', 'rina-1', store.revision())
  store.reset()
  expect(store.takeTidyMaintenance()).toEqual([])
})

it('a restart before the batches loses nothing that the maintenance pass does not recover', () => {
  const dir = mkdtempSync(join(tmpdir(), 'brain-maintenance-'))
  const path = join(dir, 'brain.sqlite')
  try {
    const first = openBrainStore({ path, Database: DatabaseSync })
    const db = new DatabaseSync(path)
    hub(db, 2100)
    db.close()
    first.merge('rina-2', 'rina-1', first.revision())
    first.close()
    const reopened = openBrainStore({ path, Database: DatabaseSync })
    try {
      expect(reopened.takeTidyMaintenance()).toEqual([])
      expect(reopened.tidySummary().automaticFolds).toBe(0)
      let pass = reopened.sweep('all')
      while (pass.coverage.phase !== 'done') pass = reopened.sweep('all')
      expect(reopened.tidySummary().automaticFolds).toBe(1)
      expect(reopened.snapshot().counts.memories).toBe(2101)
    } finally {
      reopened.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
