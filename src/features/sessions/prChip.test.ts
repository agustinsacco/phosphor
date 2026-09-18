import { describe, it, expect } from 'vitest'
import type { GhPullRequest } from '@shared/models'
import { prChip, noPrChip } from './prChip'

const pr = (over: Partial<GhPullRequest> = {}): GhPullRequest => ({
  number: 412,
  title: 'Ship it',
  state: 'OPEN',
  url: 'https://x/412',
  ...over,
})
const checks = (passed: number, failed: number, pending: number): GhPullRequest['checks'] => ({
  passed,
  failed,
  pending,
  total: passed + failed + pending,
})

describe('prChip', () => {
  it('separates approved from merely green', () => {
    expect(prChip(pr({ checks: checks(4, 0, 0) })).variant).toBe('open')
    expect(prChip(pr({ checks: checks(4, 0, 0), reviewDecision: 'APPROVED' })).variant).toBe(
      'approved',
    )
  })

  it('shows green-but-blocked-on-a-human as its own state', () => {
    const chip = prChip(pr({ checks: checks(4, 0, 0), reviewDecision: 'CHANGES_REQUESTED' }))
    expect(chip.variant).toBe('blocked')
    expect(chip.glyph).toBe('±')
  })

  it('lets a failing check outrank the review verdict', () => {
    const chip = prChip(pr({ checks: checks(3, 1, 0), reviewDecision: 'APPROVED' }))
    expect(chip.variant).toBe('failing')
  })

  it('reports running checks as pending, not as passing', () => {
    expect(prChip(pr({ checks: checks(3, 0, 1) })).variant).toBe('pending')
  })

  it('keeps a draft neutral, but still reddens a broken one', () => {
    expect(prChip(pr({ state: 'DRAFT', checks: checks(0, 0, 2) })).variant).toBe('draft')
    expect(prChip(pr({ state: 'DRAFT', checks: checks(0, 1, 0) })).variant).toBe('failing')
  })

  it('lets terminal states win over a stale red run', () => {
    // A merged PR whose last run was red is still merged; colouring it red
    // sends the reader to fix a branch that is already in.
    expect(prChip(pr({ state: 'MERGED', checks: checks(0, 1, 0) })).variant).toBe('merged')
    expect(prChip(pr({ state: 'CLOSED', checks: checks(0, 1, 0) })).variant).toBe('closed')
  })

  it('treats a PR with no checks at all as plain open', () => {
    expect(prChip(pr()).variant).toBe('open')
    expect(prChip(pr()).title).toContain('no checks')
  })

  it('never claims green checks when a lightweight query omitted them', () => {
    for (const reviewDecision of [undefined, 'APPROVED'] as const) {
      const chip = prChip(pr({ checks: null, reviewDecision }))
      expect(chip.label).toBe('#412')
      expect(chip.glyph).toBe('')
      expect(chip.title).toContain('checks unavailable')
    }
  })

  it('always labels with the PR number', () => {
    expect(prChip(pr({ number: 7 })).label).toBe('#7')
  })

  it('flags merge conflicts even when checks are green', () => {
    const chip = prChip(pr({ mergeable: 'CONFLICTING', checks: checks(4, 0, 0) }))
    expect(chip.variant).toBe('conflict')
    expect(chip.title).toContain('merge conflicts')
  })

  it('lets a conflict outrank a failing check, not just a passing one', () => {
    expect(prChip(pr({ mergeable: 'CONFLICTING', checks: checks(0, 1, 0) })).variant).toBe(
      'conflict',
    )
  })

  it('keeps a conflicting draft neutral — draft still wins', () => {
    expect(prChip(pr({ state: 'DRAFT', mergeable: 'CONFLICTING' })).variant).toBe('draft')
  })

  it('lets terminal states outrank conflicts too', () => {
    expect(prChip(pr({ state: 'MERGED', mergeable: 'CONFLICTING' })).variant).toBe('merged')
  })

  it('does not flag an unknown or clean mergeable state', () => {
    expect(prChip(pr({ mergeable: 'UNKNOWN' })).variant).toBe('open')
    expect(prChip(pr({ mergeable: 'MERGEABLE' })).variant).toBe('open')
  })
})

describe('noPrChip', () => {
  it('is inert — no PR number, no link target', () => {
    const chip = noPrChip()
    expect(chip.variant).toBe('no-pr')
    expect(chip.label).not.toMatch(/#\d/)
  })
})
