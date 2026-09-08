import { describe, expect, it } from 'vitest'
import type { GhPullRequest, SessionMeta } from '@shared/models'
import { boardHeadline, buildLaneBoard, checksGreen, classifyLane } from './laneState'

const meta = (overrides: Partial<SessionMeta> = {}): SessionMeta => ({
  path: '/s.jsonl',
  sessionId: 's',
  cwd: '/repo',
  createdAt: '2026-09-01T00:00:00.000Z',
  userMessages: 1,
  assistantMessages: 1,
  toolCalls: 0,
  totalTokens: 100,
  inputTokens: 60,
  outputTokens: 40,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  cost: 0,
  headroomSavedTokens: 0,
  entryCount: 2,
  branchCount: 0,
  mtimeMs: 1_700_000_000_000,
  lastActivityAt: '2026-09-01T00:01:00.000Z',
  ...overrides,
})

const pr = (overrides: Partial<GhPullRequest> = {}): GhPullRequest => ({
  number: 1,
  title: 'A PR',
  state: 'OPEN',
  url: 'https://example.test/1',
  ...overrides,
})

const lane = (overrides: Partial<Parameters<typeof classifyLane>[0]> = {}) => ({
  meta: meta(),
  isStreaming: false,
  hasPendingQuestion: false,
  ...overrides,
})

describe('checksGreen', () => {
  it('treats a repo with no CI as green — it is what the merge button does', () => {
    expect(checksGreen(pr())).toBe(true)
    expect(checksGreen(pr({ checks: { passed: 0, failed: 0, pending: 0, total: 0 } }))).toBe(true)
  })

  it('holds a lane back on a pending check, not only a failing one', () => {
    expect(checksGreen(pr({ checks: { passed: 3, failed: 0, pending: 1, total: 4 } }))).toBe(false)
    expect(checksGreen(pr({ checks: { passed: 4, failed: 0, pending: 0, total: 4 } }))).toBe(true)
  })
})

describe('classifyLane', () => {
  it('puts a question above everything else, even a green PR', () => {
    const out = classifyLane(
      lane({
        hasPendingQuestion: true,
        isStreaming: true,
        pr: pr({ checks: { passed: 2, failed: 0, pending: 0, total: 2 } }),
      }),
    )
    expect(out).toMatchObject({ state: 'blocked', action: 'answer' })
  })

  it('puts streaming above PR state — the answer there is "wait"', () => {
    const out = classifyLane(lane({ isStreaming: true, pr: pr() }))
    expect(out).toMatchObject({ state: 'running', action: 'open' })
  })

  it('offers merge only for an OPEN PR whose checks are green', () => {
    expect(classifyLane(lane({ pr: pr() }))).toMatchObject({ state: 'ready', action: 'merge' })
    // A draft is in flight, not mergeable.
    expect(classifyLane(lane({ pr: pr({ state: 'DRAFT' }) }))).toMatchObject({
      state: 'review',
      detail: 'draft',
    })
    // A closed or merged PR says nothing about the lane any more.
    expect(classifyLane(lane({ pr: pr({ state: 'MERGED' }) }))).toBeNull()
    expect(classifyLane(lane({ pr: pr({ state: 'CLOSED' }) }))).toBeNull()
  })

  it('keeps an open PR on the board while its checks are still running', () => {
    // The gap this closes: gating `ready` on green checks alone dropped a
    // half-green PR off every column, so a lane went quiet at exactly the
    // moment it was closest to landing.
    const out = classifyLane(
      lane({ pr: pr({ checks: { passed: 3, failed: 0, pending: 1, total: 4 } }) }),
    )
    expect(out).toMatchObject({ state: 'review', detail: 'checks running', action: 'open' })
  })

  it('calls a green draft a draft, not something ready to merge', () => {
    const out = classifyLane(
      lane({ pr: pr({ state: 'DRAFT', checks: { passed: 2, failed: 0, pending: 0, total: 2 } }) }),
    )
    expect(out).toMatchObject({ state: 'review', detail: 'draft', action: 'open' })
  })

  it('names the failing checks rather than saying "attention"', () => {
    const out = classifyLane(
      lane({ pr: pr({ checks: { passed: 1, failed: 2, pending: 0, total: 3 } }) }),
    )
    expect(out).toMatchObject({ state: 'attention', detail: '2 checks failing', action: 'open' })
  })

  it('ranks changes-requested above a red build: a human is the blocker', () => {
    const out = classifyLane(
      lane({
        pr: pr({
          reviewDecision: 'CHANGES_REQUESTED',
          checks: { passed: 0, failed: 1, pending: 0, total: 1 },
        }),
      }),
    )
    expect(out).toMatchObject({ state: 'attention', detail: 'changes requested' })
  })

  it('says a green PR is approved when it is, because that changes the decision', () => {
    expect(classifyLane(lane({ pr: pr({ reviewDecision: 'APPROVED' }) }))?.detail).toBe(
      'approved, checks green',
    )
    expect(classifyLane(lane({ pr: pr({ reviewDecision: 'REVIEW_REQUIRED' }) }))?.detail).toBe(
      'checks green',
    )
  })

  it('offers update only to a worktree lane behind main', () => {
    const behind = { isRepo: true, branch: 'x', behind: 3 }
    expect(classifyLane(lane({ git: { ...behind, isWorktree: true } }))).toMatchObject({
      state: 'attention',
      detail: '3 behind main',
      action: 'update',
    })
    // The main checkout has no branch of its own to rebase.
    expect(classifyLane(lane({ git: behind }))).toBeNull()
  })

  it('is null for an idle lane with nothing to do', () => {
    expect(classifyLane(lane())).toBeNull()
    expect(classifyLane(lane({ git: { isRepo: true, branch: 'x', isWorktree: true } }))).toBeNull()
  })

  it('carries the title, branch and cost the card renders', () => {
    const out = classifyLane(
      lane({
        meta: meta({ name: 'Fix the composer', cost: 1.25 }),
        git: { isRepo: true, branch: 'phosphor/fix', isWorktree: true },
        isStreaming: true,
      }),
    )
    expect(out).toMatchObject({ title: 'Fix the composer', branch: 'phosphor/fix', cost: 1.25 })
  })
})

describe('buildLaneBoard', () => {
  it('counts lanes with nothing to do rather than rendering them', () => {
    const board = buildLaneBoard([lane(), lane(), lane({ isStreaming: true })])
    expect(board.idleCount).toBe(2)
    expect(board.columns.running).toHaveLength(1)
  })

  it('sorts each column by most recent activity', () => {
    const board = buildLaneBoard([
      lane({
        meta: meta({ path: '/old.jsonl', lastActivityAt: '2026-09-01T00:00:00.000Z' }),
        pr: pr(),
      }),
      lane({
        meta: meta({ path: '/new.jsonl', lastActivityAt: '2026-09-02T00:00:00.000Z' }),
        pr: pr(),
      }),
    ])
    expect(board.columns.ready.map((l) => l.path)).toEqual(['/new.jsonl', '/old.jsonl'])
  })

  it('falls back to mtime when the activity stamp is unparseable', () => {
    const board = buildLaneBoard([
      lane({ meta: meta({ lastActivityAt: 'not a date', mtimeMs: 42 }), isStreaming: true }),
    ])
    expect(board.columns.running[0]?.lastActivityAt).toBe(42)
  })
})

describe('boardHeadline', () => {
  const empty = buildLaneBoard([])

  it('is null when there is nothing to say', () => {
    expect(boardHeadline(empty)).toBeNull()
  })

  it('leads with questions, then merges, then pushes, then review, then running', () => {
    expect(
      boardHeadline(buildLaneBoard([lane({ hasPendingQuestion: true }), lane({ pr: pr() })])),
    ).toBe('1 waiting on you')
    expect(boardHeadline(buildLaneBoard([lane({ pr: pr() }), lane({ isStreaming: true })]))).toBe(
      '1 ready to merge',
    )
    expect(
      boardHeadline(
        buildLaneBoard([lane({ pr: pr({ state: 'DRAFT' }) }), lane({ isStreaming: true })]),
      ),
    ).toBe('1 in review')
    expect(boardHeadline(buildLaneBoard([lane({ isStreaming: true })]))).toBe('1 running')
  })

  it('agrees with itself on plurals', () => {
    const one = buildLaneBoard([lane({ git: { isRepo: true, isWorktree: true, behind: 1 } })])
    const two = buildLaneBoard([
      lane({ meta: meta({ path: '/a' }), git: { isRepo: true, isWorktree: true, behind: 1 } }),
      lane({ meta: meta({ path: '/b' }), git: { isRepo: true, isWorktree: true, behind: 2 } }),
    ])
    expect(boardHeadline(one)).toBe('1 needs a push')
    expect(boardHeadline(two)).toBe('2 need a push')
  })
})
