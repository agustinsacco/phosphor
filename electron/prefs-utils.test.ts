import { describe, expect, it } from 'vitest'
import type { ComposerDraftRecord } from '@shared/models'
import {
  blobIdsOf,
  orphanBlobIds,
  pruneDrafts,
  pruneSeenSessions,
  sweepDrafts,
  pruneLaneMarkers,
  visibleWorkspaces,
} from './prefs-utils'

const draft = (key: string, updatedAt: number, blobIds: string[] = []): ComposerDraftRecord => ({
  key,
  text: 'hi',
  updatedAt,
  attachments: blobIds.map((blobId) => ({
    kind: 'image' as const,
    name: 'shot.png',
    size: 10,
    blobId,
  })),
})

const byKey = (...drafts: ComposerDraftRecord[]): Record<string, ComposerDraftRecord> =>
  Object.fromEntries(drafts.map((d) => [d.key, d]))

describe('pruneSeenSessions', () => {
  it('returns the same map while under the cap', () => {
    const seen = { '/a': 1, '/b': 2 }
    expect(pruneSeenSessions(seen)).toBe(seen)
  })

  it('keeps the newest entries once over the cap', () => {
    const seen = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`/s${i}`, i]))
    const pruned = pruneSeenSessions(seen, 8, 5)
    expect(Object.keys(pruned)).toHaveLength(5)
    expect(pruned['/s9']).toBe(9)
    expect(pruned['/s5']).toBe(5)
    expect(pruned['/s4']).toBeUndefined()
  })

  it('does not prune at exactly the cap', () => {
    const seen = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`/s${i}`, i]))
    expect(pruneSeenSessions(seen, 8, 5)).toBe(seen)
  })
})

describe('pruneDrafts', () => {
  it('leaves the map alone while under the cap', () => {
    const drafts = byKey(draft('a', 1), draft('b', 2))
    const result = pruneDrafts(drafts, 5)
    expect(result.drafts).toBe(drafts)
    expect(result.dropped).toEqual([])
  })

  it('keeps the newest drafts', () => {
    const drafts = byKey(draft('old', 1), draft('mid', 2), draft('new', 3))
    expect(Object.keys(pruneDrafts(drafts, 2).drafts).sort()).toEqual(['mid', 'new'])
  })

  it('reports the blob ids it dropped, so the files can be unlinked', () => {
    const drafts = byKey(draft('old', 1, ['blob-old']), draft('new', 2, ['blob-new']))
    const result = pruneDrafts(drafts, 1)
    expect(result.dropped).toEqual(['blob-old'])
  })

  it('drops nothing at exactly the cap', () => {
    const drafts = byKey(draft('a', 1, ['x']), draft('b', 2, ['y']))
    expect(pruneDrafts(drafts, 2).dropped).toEqual([])
  })
})

describe('blobIdsOf', () => {
  it('collects every image blob and ignores path attachments', () => {
    const withFile: ComposerDraftRecord = {
      ...draft('a', 1, ['one', 'two']),
      attachments: [
        ...draft('a', 1, ['one', 'two']).attachments,
        { kind: 'file', name: 'a.pdf', size: 4, path: '/tmp/a.pdf' },
      ],
    }
    expect(blobIdsOf([withFile])).toEqual(['one', 'two'])
  })

  it('tolerates a record with no attachments array', () => {
    expect(blobIdsOf([{ key: 'a', text: '', updatedAt: 0 } as ComposerDraftRecord])).toEqual([])
  })
})

describe('sweepDrafts', () => {
  const exists = (path: string): boolean => path === '/live'

  it('drops a home draft whose workspace is gone', () => {
    const drafts = byKey(draft('home:/gone', 1, ['blob-gone']), draft('home:/live', 2))
    const result = sweepDrafts(drafts, exists)
    expect(Object.keys(result.drafts)).toEqual(['home:/live'])
    expect(result.dropped).toEqual(['blob-gone'])
  })

  it('never drops a session draft — its key says nothing about disk', () => {
    const drafts = byKey(draft('session:/repo/s.jsonl', 1))
    expect(Object.keys(sweepDrafts(drafts, () => false).drafts)).toEqual(['session:/repo/s.jsonl'])
  })

  it('keeps everything when every workspace is alive', () => {
    const drafts = byKey(draft('home:/live', 1))
    expect(sweepDrafts(drafts, exists).dropped).toEqual([])
  })
})

describe('orphanBlobIds', () => {
  it('names files no surviving draft refers to', () => {
    const drafts = byKey(draft('a', 1, ['kept']))
    expect(orphanBlobIds(drafts, ['kept', 'stray-1', 'stray-2'])).toEqual(['stray-1', 'stray-2'])
  })

  it('returns everything when there are no drafts left', () => {
    expect(orphanBlobIds({}, ['a', 'b'])).toEqual(['a', 'b'])
  })

  it('returns nothing when the directory is empty', () => {
    expect(orphanBlobIds(byKey(draft('a', 1, ['x'])), [])).toEqual([])
  })
})

describe('pruneLaneMarkers', () => {
  it('leaves a small map identical, preserving identity', () => {
    const markers = { '/a': '🚀', '/b': '🦊' }
    expect(pruneLaneMarkers(markers)).toBe(markers)
  })

  it('keeps the most recently inserted entries once over the cap', () => {
    const markers = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`/s${i}`, '🚀']))
    const pruned = pruneLaneMarkers(markers, 8, 5)
    expect(Object.keys(pruned)).toEqual(['/s5', '/s6', '/s7', '/s8', '/s9'])
  })

  it('does not prune at exactly the cap', () => {
    const markers = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`/s${i}`, '🚀']))
    expect(pruneLaneMarkers(markers, 8, 5)).toBe(markers)
  })
})

describe('visibleWorkspaces', () => {
  const ws = (path: string) => ({ path, name: path.split('/').pop()!, lastOpenedAt: 1 })
  const isWorktree = (p: string) => p.includes('/.phosphor/worktrees/')

  it('drops worktree folders and folders that are gone', () => {
    const alive = new Set(['/repo'])
    expect(
      visibleWorkspaces(
        [ws('/repo'), ws('/repo/.phosphor/worktrees/lane'), ws('/deleted')],
        isWorktree,
        (p) => alive.has(p),
      ).map((w) => w.path),
    ).toEqual(['/repo'])
  })

  it('keeps the caller order', () => {
    expect(
      visibleWorkspaces([ws('/b'), ws('/a')], isWorktree, () => true).map((w) => w.path),
    ).toEqual(['/b', '/a'])
  })
})
