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

describe('selectReclaimable', () => {
  it('reclaims a clean, merged, idle lane', () => {
    const { candidates, held } = selectReclaimable([facts()], opts)
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
    const { candidates, held } = selectReclaimable([facts(over)], opts)
    expect(candidates).toEqual([])
    expect(held[0]?.reason).toBe(reason)
  })

  it('holds a lane a live session is using, by real path', () => {
    const { candidates, held } = selectReclaimable([facts({ realPath: '/real/lane' })], {
      ...opts,
      protectedPaths: ['/real/lane'],
    })
    expect(candidates).toEqual([])
    expect(held[0]?.reason).toBe('in-use')
  })

  it('holds a lane protected by its unresolved path too', () => {
    const { held } = selectReclaimable([facts()], {
      ...opts,
      protectedPaths: ['/repo/.phosphor/worktrees/lane'],
    })
    expect(held[0]?.reason).toBe('in-use')
  })

  it('checks dirty before merged, so uncommitted work is never mislabelled', () => {
    const { held } = selectReclaimable([facts({ dirtyCount: 3, merged: false })], opts)
    expect(held[0]?.reason).toBe('dirty')
  })

  it('reclaims exactly at the age boundary', () => {
    const { candidates } = selectReclaimable([facts({ lastWriteMs: NOW - 24 * HOUR })], opts)
    expect(candidates).toHaveLength(1)
  })

  it('separates many lanes into candidates and holds', () => {
    const { candidates, held } = selectReclaimable(
      [
        facts({ path: '/a', realPath: '/a' }),
        facts({ path: '/b', realPath: '/b', dirtyCount: 2 }),
        facts({ path: '/c', realPath: '/c', merged: false }),
      ],
      opts,
    )
    expect(candidates.map((c) => c.path)).toEqual(['/a'])
    expect(held.map((h) => h.reason)).toEqual(['dirty', 'unmerged'])
  })
})

describe('totalBytes', () => {
  it('sums measured sizes and ignores unmeasured ones', () => {
    expect(totalBytes([{ bytes: 10 }, { bytes: null }, { bytes: 5 }])).toBe(15)
  })
})
