import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { openBrainStore } from './store'
import { fixture } from './test-support'

function oldDatabase(path: string, version: 4 | 5): void {
  const db = new DatabaseSync(path)
  db.exec(readFileSync(new URL('./__fixtures__/schema-v4.sql', import.meta.url), 'utf8'))
  db.exec(`INSERT INTO meta VALUES ('revision','4'),('generation','Harbor'),('memories','1'),('entities','1'),('memory_bits','0'),('entity_bits','0');
    INSERT INTO entities VALUES (1,'rina','Rina Okafor','person','Ledger lead',1,1,0);
    INSERT INTO memories VALUES (1,'memory','Rina leads Ledger','fact','reported','/Harbor',NULL,NULL,NULL,1,1,'active','lane','Harbor',NULL);
    INSERT INTO mentions VALUES (1,1);`)
  if (version === 5)
    db.exec(`ALTER TABLE jobs ADD COLUMN replaces TEXT;
    CREATE INDEX memories_origin ON memories(origin_session);
    CREATE INDEX jobs_finished ON jobs(state, finished_at DESC); PRAGMA user_version=5;`)
  db.close()
}
it('creates version 8 with an empty resumable sweep and no startup fingerprint backfill', () => {
  const { db } = fixture()
  expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 8 })
  expect(db.prepare('SELECT * FROM tidy_memory_keys').all()).toEqual([])
  expect(db.prepare('SELECT phase,cursor FROM tidy_sweep').get()).toEqual({
    phase: 'entities',
    cursor: 0,
  })
})
it.each([4, 5] as const)('upgrades version %i to 8 without changing existing rows', (version) => {
  const dir = mkdtempSync(join(tmpdir(), 'brain-v6-'))
  const path = join(dir, 'brain.sqlite')
  try {
    oldDatabase(path, version)
    const db = new DatabaseSync(path)
    const tables = db
      .prepare(
        "SELECT name FROM pragma_table_list WHERE schema='main' AND type='table' AND name NOT LIKE 'sqlite_%'",
      )
      .all()
      .map((row) => String(row.name))
    // Columns as they were, so the columns later versions add are left out of the comparison.
    const select = tables.map(
      (table) =>
        `SELECT ${db
          .prepare('SELECT name FROM pragma_table_info(?)')
          .all(table)
          .map((row) => String(row.name))
          .join(',')} FROM ${table}`,
    )
    const before = select.map((sql) => db.prepare(sql).all())
    const store = openBrainStore({ path, Database: DatabaseSync })
    expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 8 })
    expect(select.map((sql) => db.prepare(sql).all())).toEqual(before)
    expect(store.memory('memory').memory.summary).toBe('Rina leads Ledger')
    expect(db.prepare('SELECT * FROM tidy_memory_keys').all()).toEqual([])
    store.close()
    db.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
it('rolls back a failed v5 migration and refuses version 9 without resetting', () => {
  const dir = mkdtempSync(join(tmpdir(), 'brain-v6-failure-'))
  const path = join(dir, 'brain.sqlite')
  try {
    oldDatabase(path, 5)
    class Interrupted extends DatabaseSync {
      override exec(sql: string): void {
        if (sql.includes('CREATE TABLE tidy_suggestions'))
          throw new Error('Interrupted Tidy migration')
        super.exec(sql)
      }
    }
    expect(() => openBrainStore({ path, Database: Interrupted })).toThrow(
      'Interrupted Tidy migration',
    )
    const db = new DatabaseSync(path)
    expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 5 })
    expect(db.prepare('SELECT summary FROM memories').get()).toEqual({
      summary: 'Rina leads Ledger',
    })
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'tidy_%'").all()).toEqual([])
    db.exec('PRAGMA user_version=9')
    expect(() => openBrainStore({ path, Database: DatabaseSync })).toThrow('newer application')
    expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 9 })
    db.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
