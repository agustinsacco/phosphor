import { expect, it } from 'vitest'
import { loadRoutineSqlite } from './sqlite'

it('exposes one reusable builtin constructor with FTS5 and transactional rollback', () => {
  const { DatabaseSync } = loadRoutineSqlite()
  expect(loadRoutineSqlite().DatabaseSync).toBe(DatabaseSync)
  const db = new DatabaseSync(':memory:')
  try {
    db.exec('CREATE VIRTUAL TABLE facts USING fts5(text)')
    db.prepare('INSERT INTO facts(text) VALUES (?)').run('original evidence')
    db.exec('BEGIN; DELETE FROM facts; ROLLBACK')
    expect(db.prepare('SELECT text FROM facts WHERE facts MATCH ?').all('evidence')).toEqual([
      { text: 'original evidence' },
    ])
  } finally {
    db.close()
  }
})
