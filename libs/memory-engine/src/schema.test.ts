import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_BRAIN_PREFS } from '@phosphor/shared/brain'
import { openBrainStore } from './store'
import { approve, fixture } from './test-support'

describe('Brain v4 SQLite schema and preferences', () => {
  it.each([0, 1, 2, 3])(
    'replaces version %i including FTS while preserving preferences',
    (version) => {
      const dir = mkdtempSync(join(tmpdir(), 'brain-v4-'))
      const path = join(dir, 'brain.sqlite')
      try {
        const old = new DatabaseSync(path)
        const previousSchema = readFileSync(
          new URL('./__fixtures__/schema-v3.sql', import.meta.url),
          'utf8',
        )
        old.exec(previousSchema)
        old.exec(`INSERT INTO meta VALUES ('prefs','{"enabled":true,"recall":false,"review":false}');
        INSERT INTO entities VALUES ('old','Harbor','project','[]',1);
        INSERT INTO memories(id,scope,subject_id,predicate,summary,type,kind,recorded_at,state)
        VALUES ('old','/made-up/harbor','old','about','Harbor fact','fact','reported',1,'active');
        INSERT INTO memory_fts VALUES ('old','discard'); PRAGMA user_version=${version};`)
        old.close()
        const store = openBrainStore({ path, Database: DatabaseSync })
        expect(store.snapshot()).toMatchObject({
          prefs: { enabled: true, recall: false, review: true },
          revision: 0,
          counts: { memories: 0, entities: 0 },
          jobs: [],
        })
        expect(store.snapshot().generation).toBeTruthy()
        store.close()
        const db = new DatabaseSync(path)
        expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 4 })
        expect(db.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' })
        expect(
          db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'memory_fts%'").all(),
        ).toEqual([])
        expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([])
        db.close()
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
  )
  it('resets all knowledge and jobs, retains prefs with review on and changes generation', () => {
    const { store } = fixture()
    store.setPrefs({ enabled: true, recall: false, review: false })
    approve(store)
    const generation = store.snapshot().generation
    store.reset()
    expect(store.snapshot()).toMatchObject({
      prefs: { enabled: true, recall: false, review: true },
      revision: 0,
      jobs: [],
      counts: { memories: 0, entities: 0 },
    })
    expect(store.snapshot().generation).not.toBe(generation)
  })
  it('merges persisted partial preferences with defaults without revision changes', () => {
    const { store, db } = fixture()
    db.prepare("INSERT OR REPLACE INTO meta VALUES ('prefs', ?)").run(
      JSON.stringify({ enabled: true }),
    )
    expect(store.snapshot().prefs).toEqual({ ...DEFAULT_BRAIN_PREFS, enabled: true })
    expect(store.revision()).toBe(0)
  })
  it('does not prune extraction records or count knowledge on snapshot', () => {
    const { store, db } = fixture()
    const statements: string[] = []
    const prepare = db.prepare.bind(db)
    db.prepare = (sql) => {
      statements.push(sql)
      return prepare(sql)
    }
    store.snapshot()
    expect(statements.join('\n')).not.toMatch(/COUNT|DELETE/iu)
  })
})
