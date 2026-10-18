import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MAX_DRAFTS, type ComposerDraftRecord } from '@shared/models'
import type { PrefsGetter } from './backend'
import { clearDraft, setDraft, setDrafts } from './drafts'

vi.mock('electron-store', () => ({
  default: class {
    private data: Record<string, unknown>
    constructor(options: { defaults: Record<string, unknown> }) {
      this.data = structuredClone(options.defaults)
    }
    get(key: string): unknown {
      return this.data[key]
    }
    set(key: string, value: unknown): void {
      this.data[key] = value
    }
    delete(key: string): void {
      delete this.data[key]
    }
  },
}))

let getStore: PrefsGetter
beforeEach(async () => {
  vi.resetModules()
  getStore = (await import('./backend')).prefs
})

function draft(key: string, updatedAt: number): ComposerDraftRecord {
  return {
    key,
    text: `text ${updatedAt}`,
    updatedAt,
    attachments: [
      { kind: 'image', blobId: `blob-${key}`, name: 'image', size: 10 },
      { kind: 'file', path: '/file', name: 'file', size: 10 },
    ],
  }
}

describe('draft preferences', () => {
  it('stores and overwrites one draft without mutating the previous map', () => {
    expect(setDraft(getStore, draft('home:/repo', 1))).toEqual([])
    const previous = getStore().get('drafts')
    expect(setDraft(getStore, draft('home:/repo', 2))).toEqual([])
    expect(previous).toEqual({ 'home:/repo': draft('home:/repo', 1) })
    expect(getStore().get('drafts')).toEqual({ 'home:/repo': draft('home:/repo', 2) })
  })

  it('prunes oldest drafts on set and returns only their image blob ids', () => {
    const full = Object.fromEntries(
      Array.from({ length: MAX_DRAFTS }, (_, i) => [`key-${i}`, draft(`key-${i}`, i)]),
    )
    setDrafts(getStore, full)
    expect(setDraft(getStore, draft('new', MAX_DRAFTS))).toEqual(['blob-key-0'])
    const kept = getStore().get('drafts')
    expect(Object.keys(kept)).toHaveLength(MAX_DRAFTS)
    expect(kept).not.toHaveProperty('key-0')
    expect(kept.new).toEqual(draft('new', MAX_DRAFTS))
    expect(full['key-0']).toEqual(draft('key-0', 0))
  })

  it('returns a cleared draft image ids and does not write for an absent key', () => {
    setDrafts(getStore, { one: draft('one', 1), two: draft('two', 2) })
    const previous = getStore().get('drafts')
    expect(clearDraft(getStore, 'one')).toEqual(['blob-one'])
    expect(previous.one).toEqual(draft('one', 1))
    expect(getStore().get('drafts')).toEqual({ two: draft('two', 2) })
    const remaining = getStore().get('drafts')
    expect(clearDraft(getStore, 'absent')).toEqual([])
    expect(getStore().get('drafts')).toBe(remaining)
  })

  it('replaces the whole map without pruning the launch sweep result', () => {
    setDraft(getStore, draft('previous', 1))
    const replacement = Object.fromEntries(
      Array.from({ length: MAX_DRAFTS + 1 }, (_, i) => [`key-${i}`, draft(`key-${i}`, i)]),
    )
    setDrafts(getStore, replacement)
    expect(getStore().get('drafts')).toEqual(replacement)
    expect(getStore().get('drafts')).not.toHaveProperty('previous')
    setDrafts(getStore, {})
    expect(getStore().get('drafts')).toEqual({})
  })
})
