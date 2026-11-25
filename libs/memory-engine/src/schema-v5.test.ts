import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { openBrainStore } from './store'
import { openBrainSearch } from './search'
import { fixture } from './test-support'

it('creates fresh databases at version 8', () => {
  const { db } = fixture()
  expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 8 })
})
it('migrates a real v4 database in place without dropping any knowledge or extraction', () => {
  const dir = mkdtempSync(join(tmpdir(), 'brain-v5-'))
  const path = join(dir, 'brain.sqlite')
  try {
    const db = new DatabaseSync(path)
    db.exec(readFileSync(new URL('./__fixtures__/schema-v4.sql', import.meta.url), 'utf8'))
    db.exec(`INSERT INTO meta VALUES ('revision','7'),('generation','harbor'),('memories','1'),('entities','2'),('memory_bits','0'),('entity_bits','0');
      INSERT INTO entities VALUES (1,'harbor','Harbor','project','',1,1,1),(2,'rina','Rina Okafor','person','',1,1,1);
      INSERT INTO entity_names VALUES (1,1,'Harbor','harbor'),(2,2,'Rina Okafor','rina okafor');
      INSERT INTO memories VALUES (1,'memory','Rina owns Harbor','fact','reported','/Harbor',NULL,NULL,NULL,1,1,'active','lane','Harbor','job');
      INSERT INTO memory_words(rowid,summary) VALUES (1,'Rina owns Harbor');
      INSERT INTO mentions VALUES (1,1),(1,2);
      INSERT INTO relations VALUES (1,1,2,'owns',1,1,1);
      INSERT INTO jobs VALUES ('job','lane','/made-up/lane.jsonl','Harbor','/Harbor',NULL,'fake/model','done',1,'leaf',NULL,1,1,2,NULL,4,NULL,NULL);
      INSERT INTO extractions VALUES ('job','lane','/made-up/lane.jsonl','Harbor','leaf','fake/model','low','[]','[]',NULL,1,2);`)
    const tables = ['entities', 'memories', 'relations', 'extractions', 'mentions', 'meta']
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
    db.close()
    class Defensive extends DatabaseSync {
      override exec(sql: string) {
        expect(sql).not.toMatch(/DROP TABLE/iu)
        super.exec(sql)
      }
    }
    const store = openBrainStore({ path, Database: Defensive })
    try {
      const inspect = new DatabaseSync(path)
      expect(inspect.prepare('PRAGMA user_version').get()).toEqual({ user_version: 8 })
      expect(select.map((sql) => inspect.prepare(sql).all())).toEqual(before)
      inspect.close()
      expect(store.job('job')).toMatchObject({ state: 'done', replaces: null })
      expect(store.extraction('job').memories).toHaveLength(1)
      const search = openBrainSearch({ path, Database: DatabaseSync })
      try {
        expect(
          search
            .recall({ query: 'Harbor', vector: null, scope: null, branch: null, limit: 8, now: 2 })
            .hits.map((h) => h.memory.id),
        ).toContain('memory')
      } finally {
        search.close()
      }
    } finally {
      store.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

function schemaObjects(db: DatabaseSync) {
  return db
    .prepare(
      `SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL
    AND name NOT LIKE 'sqlite_%'
    AND name NOT IN (SELECT name FROM pragma_table_list WHERE type='shadow') ORDER BY type,name`,
    )
    .all()
    .map((row) => ({
      ...row,
      sql: String(row.sql).replace(/\s+/g, '').replaceAll('"', ''),
    }))
}
it('fresh and upgraded v7 schemas have identical objects and a failed upgrade remains v4', () => {
  const dir = mkdtempSync(join(tmpdir(), 'brain-upgrade-'))
  const path = join(dir, 'brain.sqlite')
  try {
    const old = new DatabaseSync(path)
    old.exec(readFileSync(new URL('./__fixtures__/schema-v4.sql', import.meta.url), 'utf8'))
    old.exec("INSERT INTO meta VALUES ('revision','0'),('generation','Harbor')")
    old.close()
    class Interrupted extends DatabaseSync {
      override exec(sql: string) {
        if (sql.includes('CREATE INDEX jobs_finished')) throw new Error('Interrupted upgrade')
        super.exec(sql)
      }
    }
    expect(() => openBrainStore({ path, Database: Interrupted })).toThrow('Interrupted upgrade')
    const inspect = new DatabaseSync(path)
    expect(inspect.prepare('PRAGMA user_version').get()).toEqual({ user_version: 4 })
    expect(
      inspect
        .prepare('PRAGMA table_info(jobs)')
        .all()
        .map((r) => r.name),
    ).not.toContain('replaces')
    expect(
      inspect.prepare("SELECT name FROM sqlite_master WHERE name='memories_origin'").all(),
    ).toEqual([])
    inspect.close()
    const upgraded = openBrainStore({ path, Database: DatabaseSync })
    upgraded.close()
    const fresh = fixture()
    const migrated = new DatabaseSync(path)
    expect(schemaObjects(migrated)).toEqual(schemaObjects(fresh.db))
    migrated.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

it('reopens v8 unchanged and refuses newer databases without resetting them', () => {
  const dir = mkdtempSync(join(tmpdir(), 'brain-forward-'))
  const path = join(dir, 'brain.sqlite')
  try {
    const first = openBrainStore({ path, Database: DatabaseSync })
    first.setPrefs({
      neverRead: { titles: ['1:1', '1-1', 'one on one', '1on1'], sessionIds: [] },
      enabled: true,
      recall: false,
      agentAuto: false,
      model: null,
    })
    const before = first.snapshot()
    first.close()
    const current = openBrainStore({ path, Database: DatabaseSync })
    expect(current.snapshot()).toEqual(before)
    current.close()
    const inspect = new DatabaseSync(path)
    inspect.exec('PRAGMA user_version=9')
    const objects = schemaObjects(inspect)
    const meta = inspect.prepare('SELECT * FROM meta').all()
    expect(() => openBrainStore({ path, Database: DatabaseSync })).toThrow(
      'This Brain database requires a newer application.',
    )
    expect(inspect.prepare('PRAGMA user_version').get()).toEqual({ user_version: 9 })
    expect(inspect.prepare('SELECT * FROM meta').all()).toEqual(meta)
    expect(schemaObjects(inspect)).toEqual(objects)
    inspect.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
