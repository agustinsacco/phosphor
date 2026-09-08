import { describe, expect, it } from 'vitest'
import type { SessionMeta } from '@shared/models'
import { dropSupersededSessions } from './superseded'

function meta(partial: Partial<SessionMeta> & { path: string }): SessionMeta {
  return {
    sessionId: partial.path,
    cwd: '/repo',
    createdAt: '2026-09-01T00:00:00.000Z',
    userMessages: 1,
    assistantMessages: 1,
    toolCalls: 0,
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cost: 0,
    headroomSavedTokens: 0,
    entryCount: 2,
    branchCount: 0,
    mtimeMs: 0,
    lastActivityAt: '2026-09-01T00:00:00.000Z',
    ...partial,
  }
}

const paths = (metas: SessionMeta[]): string[] => metas.map((m) => m.path)

describe('dropSupersededSessions', () => {
  it('hides the file a rewind branched away from', () => {
    const parent = meta({ path: '/s/a.jsonl', firstEntryId: 'e1' })
    const branch = meta({ path: '/s/b.jsonl', firstEntryId: 'e1', parentSession: '/s/a.jsonl' })

    expect(paths(dropSupersededSessions([parent, branch]))).toEqual(['/s/b.jsonl'])
  })

  it('hides every link of a chain of rewinds', () => {
    const a = meta({ path: '/s/a.jsonl', firstEntryId: 'e1' })
    const b = meta({ path: '/s/b.jsonl', firstEntryId: 'e1', parentSession: '/s/a.jsonl' })
    const c = meta({ path: '/s/c.jsonl', firstEntryId: 'e1', parentSession: '/s/b.jsonl' })

    expect(paths(dropSupersededSessions([a, b, c]))).toEqual(['/s/c.jsonl'])
  })

  /**
   * pi records `parentSession` for a plain successor session too. It shares no
   * entries, so hiding it would delete real history from the sidebar.
   */
  it('keeps the predecessor of a /new session, which shares no entries', () => {
    const previous = meta({ path: '/s/a.jsonl', firstEntryId: 'e1' })
    const fresh = meta({ path: '/s/b.jsonl', firstEntryId: 'e9', parentSession: '/s/a.jsonl' })

    expect(paths(dropSupersededSessions([previous, fresh]))).toEqual(['/s/a.jsonl', '/s/b.jsonl'])
  })

  it('keeps a superseded file that is still marked live', () => {
    const parent = meta({ path: '/s/a.jsonl', firstEntryId: 'e1' })
    const branch = meta({ path: '/s/b.jsonl', firstEntryId: 'e1', parentSession: '/s/a.jsonl' })

    const kept = dropSupersededSessions([parent, branch], (m) => m.path === '/s/a.jsonl')

    expect(paths(kept)).toEqual(['/s/a.jsonl', '/s/b.jsonl'])
  })

  it('returns the input untouched when nothing was branched', () => {
    const metas = [meta({ path: '/s/a.jsonl', firstEntryId: 'e1' })]

    expect(dropSupersededSessions(metas)).toBe(metas)
  })

  it('keeps sessions written before firstEntryId was recorded', () => {
    const parent = meta({ path: '/s/a.jsonl' })
    const branch = meta({ path: '/s/b.jsonl', firstEntryId: 'e1', parentSession: '/s/a.jsonl' })

    expect(paths(dropSupersededSessions([parent, branch]))).toEqual(['/s/a.jsonl', '/s/b.jsonl'])
  })
})
