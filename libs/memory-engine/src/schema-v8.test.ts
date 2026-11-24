import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { DEFAULT_BRAIN_PREFS } from '@phosphor/shared/brain'
import { openBrainStore } from './store'
import { fixture } from './test-support'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})
/** A file holding the v7 fixture: every journal kind, a read in review and one refreshing. */
function v7File(): string {
  const directory = mkdtempSync(join(tmpdir(), 'brain-v8-'))
  directories.push(directory)
  const path = join(directory, 'brain.sqlite')
  const db = new DatabaseSync(path)
  db.exec(readFileSync(new URL('./__fixtures__/schema-v7.sql', import.meta.url), 'utf8'))
  db.close()
  return path
}
function columns(db: DatabaseSync, table: string) {
  return db.prepare(`SELECT name,type,"notnull",dflt_value FROM pragma_table_info(?)`).all(table)
}
/** Every ordinary table's rows over the columns it has now, so later additions are ignored. */
function rows(db: DatabaseSync, only?: Record<string, string[]>): Record<string, unknown[]> {
  const tables = db
    .prepare(
      "SELECT name FROM pragma_table_list WHERE schema='main' AND type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all()
    .map((row) => String(row.name))
  return Object.fromEntries(
    tables.map((table) => {
      const names = only?.[table] ?? columns(db, table).map((column) => String(column.name))
      const found = db.prepare(`SELECT ${names.join(',')} FROM ${table}`).all()
      return [table, found.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))]
    }),
  )
}
function schemaObjects(db: DatabaseSync) {
  return db
    .prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
}
function version(db: DatabaseSync): unknown {
  return db.prepare('PRAGMA user_version').get()
}

it('creates fresh databases at version 8 with the v8 columns and tables', () => {
  const { db } = fixture()
  expect(version(db)).toEqual({ user_version: 8 })
  expect(columns(db, 'memory_use').map((column) => column.name)).toEqual([
    'memory',
    'recalled',
    'last_recalled',
    'flagged',
  ])
  expect(columns(db, 'agent_runs').map((column) => column.name)).toContain('automatic')
  expect(columns(db, 'tidy_suggestions').map((column) => column.name)).toContain('detail')
})

it('migrates a v7 Brain in place: new columns with their defaults, no row lost', () => {
  const path = v7File()
  const old = new DatabaseSync(path)
  const before = rows(old)
  const oldColumns = Object.fromEntries(
    Object.keys(before).map((table) => [
      table,
      columns(old, table).map((column) => String(column.name)),
    ]),
  )
  old.close()
  openBrainStore({ path, Database: DatabaseSync }).close()
  const db = new DatabaseSync(path)
  try {
    expect(version(db)).toEqual({ user_version: 8 })
    const after = rows(db, oldColumns)
    for (const table of Object.keys(before).filter((name) => !['jobs', 'meta'].includes(name)))
      expect(after[table], table).toEqual(before[table])
    const settings = (list: unknown[] = []) =>
      list.filter((row) => (row as { key: string }).key !== 'prefs')
    expect(settings(after.meta)).toEqual(settings(before.meta))
    expect(columns(db, 'relations').slice(-4)).toEqual([
      { name: 'label', type: 'TEXT', notnull: 1, dflt_value: "''" },
      { name: 'valid_from', type: 'INTEGER', notnull: 0, dflt_value: null },
      { name: 'valid_to', type: 'INTEGER', notnull: 0, dflt_value: null },
      { name: 'stated_by', type: 'TEXT', notnull: 1, dflt_value: "'reader'" },
    ])
    expect(columns(db, 'memories').at(-1)).toEqual({
      name: 'importance',
      type: 'INTEGER',
      notnull: 1,
      dflt_value: '1',
    })
    expect(columns(db, 'tidy_suggestions').at(-1)).toEqual({
      name: 'detail',
      type: 'TEXT',
      notnull: 0,
      dflt_value: null,
    })
    expect(columns(db, 'agent_runs').at(-1)).toEqual({
      name: 'automatic',
      type: 'INTEGER',
      notnull: 1,
      dflt_value: '0',
    })
    expect(
      db.prepare('SELECT DISTINCT label,valid_from,valid_to,stated_by FROM relations').all(),
    ).toEqual([{ label: '', valid_from: null, valid_to: null, stated_by: 'reader' }])
    expect(db.prepare('SELECT DISTINCT importance FROM memories').all()).toEqual([
      { importance: 1 },
    ])
    expect(db.prepare('SELECT COUNT(*) AS n FROM tidy_suggestions').get()).toEqual({
      n: (before.tidy_suggestions ?? []).length,
    })
    expect(db.prepare('SELECT DISTINCT detail FROM tidy_suggestions').all()).toEqual([
      { detail: null },
    ])
    expect(db.prepare('SELECT DISTINCT automatic FROM agent_runs').all()).toEqual([
      { automatic: 0 },
    ])
    expect(db.prepare('SELECT * FROM memory_use').all()).toEqual([])
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
    expect(db.prepare('SELECT COUNT(*) AS n FROM tidy_operations').get()).toEqual({ n: 12 })
  } finally {
    db.close()
  }
})

it('queues reads that waited in review or were refreshing, keeping their proposals', () => {
  const path = v7File()
  const old = new DatabaseSync(path)
  const waiting = old
    .prepare("SELECT id FROM jobs WHERE state IN ('review','refreshing') ORDER BY id")
    .all()
    .map((row) => String(row.id))
  const finished = old.prepare("SELECT * FROM jobs WHERE state IN ('done','rejected')").all()
  const proposals = old.prepare('SELECT * FROM proposals ORDER BY job_id').all()
  const parts = old.prepare('SELECT COUNT(*) AS n FROM proposal_vectors').get()
  old.close()
  expect(waiting).toHaveLength(2)
  const store = openBrainStore({ path, Database: DatabaseSync })
  try {
    expect(store.snapshot().jobs.filter((job) => waiting.includes(job.id))).toEqual(
      waiting.map((id) =>
        expect.objectContaining({
          id,
          state: 'queued',
          runStartedAt: null,
          error: null,
          progress: null,
        }),
      ),
    )
  } finally {
    store.close()
  }
  const db = new DatabaseSync(path)
  try {
    expect(db.prepare("SELECT * FROM jobs WHERE state IN ('done','rejected')").all()).toEqual(
      finished,
    )
    expect(
      db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE state IN ('review','refreshing')").get(),
    ).toEqual({ n: 0 })
    expect(db.prepare('SELECT * FROM proposals ORDER BY job_id').all()).toEqual(proposals)
    expect(db.prepare('SELECT COUNT(*) AS n FROM proposal_vectors').get()).toEqual(parts)
  } finally {
    db.close()
  }
})

it('rewrites stored prefs without review and with the automatic Brain Agent check on', () => {
  const path = v7File()
  const old = new DatabaseSync(path)
  const stored = old.prepare("SELECT value FROM meta WHERE key='prefs'").get() as { value: string }
  old.close()
  expect(JSON.parse(stored.value)).toMatchObject({ enabled: true, review: false })
  const store = openBrainStore({ path, Database: DatabaseSync })
  try {
    expect(store.snapshot().prefs).toEqual({ ...DEFAULT_BRAIN_PREFS, enabled: true })
  } finally {
    store.close()
  }
  const db = new DatabaseSync(path)
  try {
    const value = db.prepare("SELECT value FROM meta WHERE key='prefs'").get() as { value: string }
    expect(JSON.parse(value.value)).toEqual({ ...DEFAULT_BRAIN_PREFS, enabled: true })
    expect(JSON.parse(value.value)).not.toHaveProperty('review')
  } finally {
    db.close()
  }
})

it('checks the new columns, cascades memory use and matches a fresh v8 schema', () => {
  const path = v7File()
  openBrainStore({ path, Database: DatabaseSync }).close()
  const db = new DatabaseSync(path)
  try {
    expect(() => db.exec("UPDATE relations SET stated_by='lane'")).toThrow(
      'CHECK constraint failed',
    )
    expect(() => db.exec('UPDATE memories SET importance=3')).toThrow('CHECK constraint failed')
    db.exec("UPDATE relations SET stated_by='agent'; UPDATE memories SET importance=2")
    const { n } = db.prepare('SELECT MIN(n) AS n FROM memories').get() as { n: number }
    db.prepare('INSERT INTO memory_use(memory,recalled,last_recalled) VALUES (?,3,1500)').run(n)
    expect(db.prepare('SELECT * FROM memory_use').all()).toEqual([
      { memory: n, recalled: 3, last_recalled: 1500, flagged: 0 },
    ])
    db.exec('PRAGMA foreign_keys=ON')
    db.prepare('DELETE FROM memories WHERE n=?').run(n)
    expect(db.prepare('SELECT * FROM memory_use').all()).toEqual([])
    expect(schemaObjects(db)).toEqual(schemaObjects(fixture().db))
  } finally {
    db.close()
  }
})

it('adds agent_runs.automatic to a v7 Brain that never had the Brain Agent tables', () => {
  const path = v7File()
  const old = new DatabaseSync(path)
  old.exec('DROP TABLE agent_notes; DROP TABLE agent_runs')
  old.close()
  openBrainStore({ path, Database: DatabaseSync }).close()
  const db = new DatabaseSync(path)
  try {
    expect(version(db)).toEqual({ user_version: 8 })
    expect(columns(db, 'agent_runs').map((column) => column.name)).toContain('automatic')
  } finally {
    db.close()
  }
})

it('rolls back an interrupted v8 upgrade to an untouched v7 file', () => {
  const path = v7File()
  const old = new DatabaseSync(path)
  const before = rows(old)
  const schema = schemaObjects(old)
  old.close()
  class Interrupted extends DatabaseSync {
    override exec(sql: string): void {
      if (sql.includes('CREATE TABLE memory_use')) {
        super.exec("ALTER TABLE relations ADD COLUMN label TEXT NOT NULL DEFAULT ''")
        throw new Error('Interrupted v8 upgrade')
      }
      super.exec(sql)
    }
  }
  expect(() => openBrainStore({ path, Database: Interrupted })).toThrow('Interrupted v8 upgrade')
  const db = new DatabaseSync(path)
  try {
    expect(version(db)).toEqual({ user_version: 7 })
    expect(schemaObjects(db)).toEqual(schema)
    expect(rows(db)).toEqual(before)
  } finally {
    db.close()
  }
})

it('refuses a version 9 Brain without resetting or changing it', () => {
  const path = v7File()
  openBrainStore({ path, Database: DatabaseSync }).close()
  const db = new DatabaseSync(path)
  try {
    db.exec('PRAGMA user_version=9')
    const before = rows(db)
    const schema = schemaObjects(db)
    expect(() => openBrainStore({ path, Database: DatabaseSync })).toThrow(
      'This Brain database requires a newer application.',
    )
    expect(version(db)).toEqual({ user_version: 9 })
    expect(rows(db)).toEqual(before)
    expect(schemaObjects(db)).toEqual(schema)
  } finally {
    db.close()
  }
})

it('reopens a v8 Brain without changing it', () => {
  const path = v7File()
  openBrainStore({ path, Database: DatabaseSync }).close()
  const db = new DatabaseSync(path)
  const before = rows(db)
  openBrainStore({ path, Database: DatabaseSync }).close()
  try {
    expect(version(db)).toEqual({ user_version: 8 })
    expect(rows(db)).toEqual(before)
  } finally {
    db.close()
  }
})
