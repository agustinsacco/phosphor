import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_BRAIN_PREFS } from '@phosphor/shared/brain'
import { openBrainStore } from './store'
import { approve, fixture } from './test-support'

describe('Brain SQLite schema and preferences', () => {
  it.each([0, 1])('discards all prototype tables and FTS at version %i', (version) => {
    const dir = mkdtempSync(join(tmpdir(), 'brain-v2-'))
    const path = join(dir, 'brain.sqlite')
    try {
      const old = new DatabaseSync(path)
      old.exec(`CREATE TABLE prototype(id TEXT PRIMARY KEY); INSERT INTO prototype VALUES ('old');
        CREATE TABLE child(id TEXT REFERENCES prototype(id));
        CREATE VIRTUAL TABLE prototype_fts USING fts5(text);
        INSERT INTO prototype_fts VALUES ('discard me'); PRAGMA user_version=${version};`)
      old.close()
      const store = openBrainStore({ path, Database: DatabaseSync })
      expect(store.snapshot()).toEqual({
        prefs: DEFAULT_BRAIN_PREFS,
        revision: 0,
        jobs: [],
        counts: { memories: 0, entities: 0 },
      })
      store.close()
      const db = new DatabaseSync(path)
      expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 2 })
      expect(
        db.prepare("SELECT name FROM sqlite_master WHERE name LIKE 'prototype%'").all(),
      ).toEqual([])
      db.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  it('persists version-two knowledge and preferences across reopen without reset', () => {
    const dir = mkdtempSync(join(tmpdir(), 'brain-v2-'))
    const path = join(dir, 'brain.sqlite')
    try {
      const store = openBrainStore({ path, Database: DatabaseSync })
      store.setPrefs({ enabled: true, recall: false, review: true })
      approve(store)
      const expected = store.knowledge()
      store.close()
      const reopened = openBrainStore({ path, Database: DatabaseSync })
      expect(reopened.snapshot()).toMatchObject({
        revision: 1,
        prefs: { enabled: true, recall: false, review: true },
      })
      expect(reopened.knowledge()).toEqual(expected)
      reopened.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  it('merges persisted partial preferences with defaults', () => {
    const { store, db } = fixture()
    db.prepare("INSERT INTO meta VALUES ('prefs', ?)").run(JSON.stringify({ enabled: true }))
    expect(store.snapshot().prefs).toEqual({ ...DEFAULT_BRAIN_PREFS, enabled: true })
    expect(store.setPrefs({ enabled: true, recall: false, review: false })).toEqual({
      enabled: true,
      recall: false,
      review: false,
    })
    expect(store.snapshot().revision).toBe(0)
  })
})
