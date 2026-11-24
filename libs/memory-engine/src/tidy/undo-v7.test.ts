import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { openBrainStore } from '../store'
import type { BrainStore } from '../types'

const directories: string[] = []
const stores: BrainStore[] = []
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})
/** The v7 fixture, migrated to v8 by opening it. */
function migrated(): { store: BrainStore } {
  const directory = mkdtempSync(join(tmpdir(), 'brain-undo-v7-'))
  directories.push(directory)
  const path = join(directory, 'brain.sqlite')
  const db = new DatabaseSync(path)
  db.exec(readFileSync(new URL('../__fixtures__/schema-v7.sql', import.meta.url), 'utf8'))
  db.close()
  const store = openBrainStore({ path, Database: DatabaseSync })
  stores.push(store)
  return { store }
}
const ADDED: Record<string, Record<string, unknown>> = {
  memories: { importance: 1 },
  relations: { label: '', valid_from: null, valid_to: null, stated_by: 'reader' },
}
type Row = Record<string, unknown>
/** Each changed row's before-image: what undo must put back, v8 columns at their defaults. */
function expected(db: DatabaseSync, operation: string) {
  return db
    .prepare(
      "SELECT table_name AS t,before_image AS image FROM tidy_operation_rows WHERE operation_id=? AND table_name!='tidy_suggestions'",
    )
    .all(operation)
    .flatMap((r) => {
      const image = JSON.parse(String(r.image)) as { key: Row; row: Row | null; guard?: true }
      if (image.guard) return []
      const table = String(r.t)
      return [{ table, key: image.key, row: image.row && { ...ADDED[table], ...image.row } }]
    })
}
function actual(db: DatabaseSync, table: string, key: Row, columns: string[]): Row | null {
  const found = db
    .prepare(
      `SELECT ${columns.join(',')} FROM ${table} WHERE ${Object.keys(key)
        .map((k) => `${k}=?`)
        .join(' AND ')}`,
    )
    .get(...(Object.values(key) as (string | number)[]))
  if (!found) return null
  return Object.fromEntries(
    Object.entries(found).map(([k, v]) => [
      k,
      v instanceof Uint8Array ? { base64: Buffer.from(v).toString('base64') } : v,
    ]),
  )
}
/** A second connection to read rows back. */
function reader(): { db: DatabaseSync; close: () => void } {
  const path = join(directories.at(-1)!, 'brain.sqlite')
  const db = new DatabaseSync(path)
  return { db, close: () => db.close() }
}

const UNDONE = [
  'id-54',
  'id-43',
  'id-40',
  'id-38',
  'id-37',
  'id-35',
  'id-34',
  'id-33',
  'id-32',
  'id-2',
]

it('undoes every v7 journal kind after the migration, newest first, back to its before-images', () => {
  const { store } = migrated()
  const { db, close } = reader()
  try {
    for (const operation of UNDONE) {
      const rows = expected(db, operation).filter(
        (r) => !['jobs', 'proposals', 'proposal_vectors', 'extractions'].includes(r.table),
      )
      expect(() => store.tidyUndo(operation, store.revision()), operation).not.toThrow()
      for (const { table, key, row } of rows)
        expect(actual(db, table, key, Object.keys(row ?? key)), `${operation} ${table}`).toEqual(
          row,
        )
    }
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
  } finally {
    close()
  }
})

it('an undone v7 approval leaves its read rejected with nothing saved and no proposal', () => {
  const { store } = migrated()
  const { db, close } = reader()
  try {
    expect(() => store.tidyUndo('id-54', store.revision())).not.toThrow()
    expect(store.job('id-50')).toMatchObject({ state: 'rejected', memories: 0 })
    expect(db.prepare("SELECT 1 FROM proposals WHERE job_id='id-50'").get()).toBeUndefined()
  } finally {
    close()
  }
})

it('refuses to bring back a read rejected in v7, and says it cannot be undone', () => {
  const { store } = migrated()
  expect(() => store.tidyUndo('id-58', store.revision())).toThrow(
    "This read was rejected in an older version and can't be brought back. Use Read again on the lane.",
  )
  expect(store.tidyChanges(50).items.find((item) => item.id === 'id-58')!.undoable).toBe(false)
  expect(() => store.tidyUndo('id-49', store.revision())).toThrow("Erasing can't be undone.")
})
