import { describe, expect, it } from 'vitest'
import { selectReclaimable, totalBytes, type WorktreeFacts } from './policy'

const HOUR = 60 * 60 * 1000
const NOW = 1_700_000_000_000

function facts(over: Partial<WorktreeFacts> = {}): WorktreeFacts {
  return {
    path: '/repo/.phosphor/worktrees/lane',
    realPath: '/repo/.phosphor/worktrees/lane',
    branch: 'phosphor/lane',
    isMain: false,
    dirtyCount: 0,
    merged: true,
    lastWriteMs: NOW - 48 * HOUR,
    bytes: 1024,
    ...over,
  }
}

const opts = { protectedPaths: [] as string[], now: NOW, minAgeHours: 24 }

function finished(over: Partial<WorktreeFacts> = {}): WorktreeFacts {
  return facts({ completedAtMs: NOW - 48 * HOUR, ...over })
}

describe('selectReclaimable', () => {
  it('reclaims a clean, merged, idle lane', () => {
    const { candidates, held } = selectReclaimable([finished()], opts)
    expect(candidates).toEqual([
      {
        path: '/repo/.phosphor/worktrees/lane',
        branch: 'phosphor/lane',
        bytes: 1024,
        reason: 'merged',
      },
    ])
    expect(held).toEqual([])
  })

  it.each([
    ['main-checkout', { isMain: true }],
    ['no-branch', { branch: null }],
    ['dirty', { dirtyCount: 1 }],
    ['unmerged', { merged: false }],
    ['too-recent', { lastWriteMs: NOW - 1 * HOUR }],
  ] as const)('holds %s', (reason, over) => {
    const { candidates, held } = selectReclaimable([finished(over)], opts)
    expect(candidates).toEqual([])
    expect(held[0]?.reason).toBe(reason)
  })

  it('holds a lane a live session is using, by real path', () => {
    const { candidates, held } = selectReclaimable([finished({ realPath: '/real/lane' })], {
      ...opts,
      protectedPaths: ['/real/lane'],
    })
    expect(candidates).toEqual([])
    expect(held[0]?.reason).toBe('in-use')
  })

  it('holds a lane protected by its unresolved path too', () => {
    const { held } = selectReclaimable([finished()], {
      ...opts,
      protectedPaths: ['/repo/.phosphor/worktrees/lane'],
    })
    expect(held[0]?.reason).toBe('in-use')
  })

  it('checks dirty before merged, so uncommitted work is never mislabelled', () => {
    const { held } = selectReclaimable([finished({ dirtyCount: 3, merged: false })], opts)
    expect(held[0]?.reason).toBe('dirty')
  })

  it('reclaims exactly at the age boundary', () => {
    const { candidates } = selectReclaimable([finished({ lastWriteMs: NOW - 24 * HOUR })], opts)
    expect(candidates).toHaveLength(1)
  })

  it('separates many lanes into candidates and holds', () => {
    const { candidates, held } = selectReclaimable(
      [
        finished({ path: '/a', realPath: '/a' }),
        finished({ path: '/b', realPath: '/b', dirtyCount: 2 }),
        finished({ path: '/c', realPath: '/c', merged: false }),
      ],
      opts,
    )
    expect(candidates.map((c) => c.path)).toEqual(['/a'])
    expect(held.map((h) => h.reason)).toEqual(['dirty', 'unmerged'])
  })
})

describe('unfinished conversation regression', () => {
  it('protects legacy sessions without an explicit completion decision', () => {
    expect(selectReclaimable([facts()], opts).candidates).toEqual([])
  })

  it('protects a merged research lane even with no running process', () => {
    const lane = { ...facts(), completedAtMs: null }
    expect(selectReclaimable([lane], opts).held[0]?.reason).toBe('unfinished')
  })

  it('respects git worktree locks', () => {
    const lane = { ...facts(), completedAtMs: NOW - 48 * HOUR, locked: true }
    expect(selectReclaimable([lane], opts).held[0]?.reason).toBe('locked')
  })

  it('starts the grace period at completion, not an old directory timestamp', () => {
    const lane = { ...facts(), completedAtMs: NOW - HOUR }
    expect(selectReclaimable([lane], opts).held[0]?.reason).toBe('too-recent')
  })
})

describe('totalBytes', () => {
  it('sums measured sizes and ignores unmeasured ones', () => {
    expect(totalBytes([{ bytes: 10 }, { bytes: null }, { bytes: 5 }])).toBe(15)
  })
})
