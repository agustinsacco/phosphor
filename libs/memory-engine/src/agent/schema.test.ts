import { describe, expect, it } from 'vitest'
import { initialize } from '../schema'
import { fixture } from '../test-support'

describe('Brain Agent additive schema', () => {
  it('opens an existing v7 twice without changing its version', () => {
    const { store, db } = fixture()
    db.exec('DROP TABLE IF EXISTS agent_notes; DROP TABLE IF EXISTS agent_runs')
    const ctx = { db, now: Date.now, id: () => 'generation' }
    initialize(ctx)
    initialize(ctx)
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE name IN ('agent_notes','agent_runs') ORDER BY name",
        )
        .all(),
    ).toEqual([{ name: 'agent_notes' }, { name: 'agent_runs' }])
    expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 7 })
    store.reset()
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM sqlite_master WHERE name IN ('agent_notes','agent_runs')",
        )
        .get(),
    ).toEqual({ n: 2 })
  })
  it('still refuses future databases', () => {
    const { db } = fixture()
    db.exec('PRAGMA user_version=8')
    expect(() => initialize({ db, now: Date.now, id: () => 'generation' })).toThrow(
      'requires a newer application',
    )
  })
})
