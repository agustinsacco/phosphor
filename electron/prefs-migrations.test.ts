import { describe, expect, it } from 'vitest'
import { migrateRenamedPrefs, type RawPrefs } from './prefs-migrations'

function fakeStore(initial: Record<string, unknown>): RawPrefs & { data: Record<string, unknown> } {
  const data = { ...initial }
  return {
    data,
    get: (key) => data[key],
    set: (key, value) => {
      data[key] = value
    },
    delete: (key) => {
      delete data[key]
    },
  }
}

describe('migrateRenamedPrefs', () => {
  it('moves a chosen Claude auto-compact window to the context budget', () => {
    // The defaults have already written `contextBudget: ''` by the time this runs.
    const store = fakeStore({ claudeAutocompact: ' 400k ', contextBudget: '' })
    migrateRenamedPrefs(store)
    expect(store.data).toEqual({ contextBudget: '400k' })
  })

  it('drops the legacy key when it only held the old default', () => {
    const store = fakeStore({ claudeAutocompact: '', contextBudget: '' })
    migrateRenamedPrefs(store)
    expect(store.data).toEqual({ contextBudget: '' })
  })

  it('never overwrites a budget that is already set', () => {
    const store = fakeStore({ claudeAutocompact: '400k', contextBudget: '300k' })
    migrateRenamedPrefs(store)
    expect(store.data).toEqual({ contextBudget: '300k' })
  })

  it('does nothing on a store that never had the legacy key', () => {
    const store = fakeStore({ contextBudget: 'auto' })
    migrateRenamedPrefs(store)
    expect(store.data).toEqual({ contextBudget: 'auto' })
  })

  it('discards a legacy value that is not a string', () => {
    const store = fakeStore({ claudeAutocompact: 400, contextBudget: '' })
    migrateRenamedPrefs(store)
    expect(store.data).toEqual({ contextBudget: '' })
  })
})
