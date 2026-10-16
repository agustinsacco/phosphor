import { describe, expect, it, vi } from 'vitest'
import { loadRoutineSqlite } from './sqlite'

const sqliteWarning = 'SQLite is an experimental feature and might change at any time'

describe('loadRoutineSqlite', () => {
  it('suppresses only the SQLite experimental warning and restores the emitter', () => {
    const original = process.emitWarning
    const forwarded = vi.fn()
    process.emitWarning = forwarded
    try {
      const sqlite = loadRoutineSqlite(() => {
        process.emitWarning(sqliteWarning, 'ExperimentalWarning')
        process.emitWarning(
          Object.assign(new Error(sqliteWarning), { name: 'ExperimentalWarning' }),
        )
        process.emitWarning(sqliteWarning, { type: 'ExperimentalWarning' })
        process.emitWarning('Other experimental feature', 'ExperimentalWarning')
        process.emitWarning('SQLite problem', 'Warning')
        return loadRoutineSqlite()
      })
      expect(sqlite.DatabaseSync).toBeTypeOf('function')
      expect(forwarded.mock.calls).toEqual([
        ['Other experimental feature', 'ExperimentalWarning'],
        ['SQLite problem', 'Warning'],
      ])
      expect(process.emitWarning).toBe(forwarded)
    } finally {
      process.emitWarning = original
    }
  })

  it('restores the emitter after load failure', () => {
    const original = process.emitWarning
    expect(() =>
      loadRoutineSqlite(() => {
        throw new Error('load failed')
      }),
    ).toThrow('load failed')
    expect(process.emitWarning).toBe(original)
  })
})
