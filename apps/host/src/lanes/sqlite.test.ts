import { expect, it, vi } from 'vitest'
import { loadSqlite } from './sqlite'

it('suppresses only SQLite experimental warnings and restores the original on success', async () => {
  const original = process.emitWarning
  const forwarded = vi.fn()
  process.emitWarning = forwarded
  try {
    await loadSqlite(async () => {
      process.emitWarning('SQLite is an experimental feature', 'ExperimentalWarning')
      process.emitWarning(
        Object.assign(new Error('SQLite experimental'), { name: 'ExperimentalWarning' }),
      )
      process.emitWarning('Other experimental feature', 'ExperimentalWarning')
      process.emitWarning('SQLite problem', 'Warning')
      process.emitWarning('SQLite experimental feature', { type: 'ExperimentalWarning' })
      return import('node:sqlite')
    })
    expect(forwarded.mock.calls.filter(([warning]) => typeof warning === 'string')).toEqual([
      ['Other experimental feature', 'ExperimentalWarning'],
      ['SQLite problem', 'Warning'],
    ])
    expect(process.emitWarning).toBe(forwarded)
  } finally {
    process.emitWarning = original
  }
})
it('restores the original warning emitter if import fails', async () => {
  const original = process.emitWarning
  await expect(
    loadSqlite(async () => {
      throw new Error('import failed')
    }),
  ).rejects.toThrow('import failed')
  expect(process.emitWarning).toBe(original)
})
