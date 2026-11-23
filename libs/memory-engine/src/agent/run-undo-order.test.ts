import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it } from 'vitest'
import { openBrainStore } from '../store'
import { seed } from '../tidy/test-support'
import type { BrainStore } from '../types'

const stores: BrainStore[] = []
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
})

/**
 * Every change lands in the same millisecond, and each id sorts before the one made before it,
 * as random UUIDs can: only insertion order tells which change came last.
 */
function sameMillisecond() {
  const databases: DatabaseSync[] = []
  class Database extends DatabaseSync {
    constructor(path: string, options?: { timeout?: number }) {
      super(path, options ?? {})
      databases.push(this)
    }
  }
  let next = 100_000
  const store = openBrainStore({
    path: ':memory:',
    Database,
    now: () => 5000,
    id: () => `id-${--next}`,
  })
  stores.push(store)
  const db = databases[0]!
  seed(db, 2)
  return { store, db }
}
const note = (runId: string | null) => ({ runId, reason: 'The role description is more precise.' })
const describe = (description: string) =>
  ({ kind: 'describe', entityId: 'rina-1', description }) as const

it('Undo run reverses dependent changes made in the same millisecond, newest first', () => {
  const { store } = sameMillisecond()
  const run = store.createRun()
  store.updateRun(run.id, { state: 'running', startedAt: 5000 })
  store.agentEdit(describe('Ledger lead at Harbor'), note(run.id))
  store.agentEdit(describe('Ledger lead at Northwind'), note(run.id))
  store.updateRun(run.id, { state: 'done', finishedAt: 5000 })
  expect(store.undoRun(run.id)).toEqual({ undone: 2, kept: 0 })
  expect(store.entity('rina-1').entity.description).toBe('Ledger lead 1')
})

it('keeps the newest 200 changes made in the same millisecond, not the oldest', () => {
  const { store, db } = sameMillisecond()
  const ids = Array.from({ length: 201 }, (_, i) =>
    store.agentEdit(describe(`Ledger lead ${i}`), note(null)),
  )
  // A new run prunes the journal to the newest 200 changes.
  store.createRun()
  const rows = db.prepare('SELECT id FROM tidy_operations').all() as { id: string }[]
  const kept = new Set(rows.map((row) => row.id))
  expect(kept.size).toBe(200)
  expect(kept.has(ids[0]!)).toBe(false)
  expect(kept.has(ids[200]!)).toBe(true)
})
