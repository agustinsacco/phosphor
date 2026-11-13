import { describe, expect, it } from 'vitest'
import type { GhPullRequest, SessionMeta } from '@shared/models'
import { prVerdict } from '@/features/sessions/prVerdict'
import { boardHeadline, buildLaneBoard, classifyLane, retainLaneOrder } from './laneState'

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

const green = { passed: 2, failed: 0, pending: 0, total: 2 }
const ready = (overrides: Partial<GhPullRequest> = {}) =>
  pr({ reviewDecision: 'APPROVED', checks: green, ...overrides })

const lane = (overrides: Partial<Parameters<typeof classifyLane>[0]> = {}) => ({
  meta: meta(),
  isStreaming: false,
  hasPendingQuestion: false,
  ...overrides,
})

describe('classifyLane', () => {
  it('keeps a quiet parent running while delegated work remains, ahead of merge readiness', () => {
    expect(classifyLane(lane({ hasDelegatedWork: true, pr: pr() }))).toMatchObject({
      state: 'running',
      detail: 'delegated work in progress',
      action: 'open',
    })
    expect(classifyLane(lane({ hasDelegatedWork: true, hasPendingQuestion: true }))).toMatchObject({
      state: 'blocked',
      action: 'answer',
    })
  })
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

  it('offers merge only for an OPEN, approved PR whose checks are green', () => {
    expect(classifyLane(lane({ pr: ready() }))).toMatchObject({ state: 'ready', action: 'merge' })
    // A draft is in flight, not mergeable.
    expect(classifyLane(lane({ pr: pr({ state: 'DRAFT' }) }))).toMatchObject({
      state: 'review',
      detail: 'Draft',
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
    expect(out).toMatchObject({
      state: 'review',
      detail: 'Checks running, 1 left',
      action: 'open',
    })
  })

  it('keeps a PR with unavailable checks in review, never ready to merge', () => {
    const missingChecks = pr({ checks: null, reviewDecision: 'APPROVED' })
    expect(classifyLane(lane({ pr: missingChecks }))).toMatchObject({
      state: 'review',
      detail: 'Approved; checks unknown',
      action: 'open',
    })
  })

  it('calls a green draft a draft, not something ready to merge', () => {
    const out = classifyLane(
      lane({ pr: pr({ state: 'DRAFT', checks: { passed: 2, failed: 0, pending: 0, total: 2 } }) }),
    )
    expect(out).toMatchObject({ state: 'review', detail: 'Draft', action: 'open' })
  })

  it('names the failing checks rather than saying "attention"', () => {
    const out = classifyLane(
      lane({ pr: pr({ checks: { passed: 1, failed: 2, pending: 0, total: 3 } }) }),
    )
    expect(out).toMatchObject({ state: 'attention', detail: '2 checks failing', action: 'open' })
  })

  it('says changes requested when a human is the only blocker', () => {
    const out = classifyLane(
      lane({ pr: pr({ reviewDecision: 'CHANGES_REQUESTED', checks: green }) }),
    )
    expect(out).toMatchObject({ state: 'attention', detail: 'Changes requested', action: 'open' })
  })

  it('leads with the verdict the sidebar and the pill show for the same PR', () => {
    const both = pr({
      reviewDecision: 'CHANGES_REQUESTED',
      checks: { passed: 0, failed: 1, pending: 0, total: 1 },
    })
    expect(classifyLane(lane({ pr: both }))).toMatchObject({
      state: 'attention',
      detail: prVerdict(both).headline,
    })
  })

  it('waits for a review on a green PR nobody approved, and names an approval', () => {
    expect(classifyLane(lane({ pr: ready() }))?.detail).toBe(
      'Approved, checks green: ready to merge',
    )
    expect(classifyLane(lane({ pr: ready({ reviewDecision: 'REVIEW_REQUIRED' }) }))).toMatchObject({
      state: 'review',
      detail: 'Waiting for review',
      action: 'open',
    })
  })

  it('keeps every owned PR for the beads, and classifies by the lead', () => {
    const lead = { key: 'k1', number: 1, stale: false, pr: ready(), verdict: prVerdict(ready()) }
    const out = classifyLane(lane({ prs: [lead] }))
    expect(out).toMatchObject({ state: 'ready', pr: lead.pr, prs: [lead] })
    expect(classifyLane(lane({ isStreaming: true }))?.prs).toEqual([])
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
  it('retains idle tiles without counting them as active work', () => {
    const board = buildLaneBoard([lane(), lane(), lane({ isStreaming: true })])
    expect(board.idleCount).toBe(2)
    expect(board.columns.running).toHaveLength(1)
    expect(board.lanes.map((lane) => lane.state)).toEqual(['idle', 'idle', 'running'])
    expect(board.lanes[0]?.detail).toBe('No active work reported')
  })

  it('sorts each column by most recent activity', () => {
    const board = buildLaneBoard([
      lane({
        meta: meta({ path: '/old.jsonl', lastActivityAt: '2026-09-01T00:00:00.000Z' }),
        pr: ready(),
      }),
      lane({
        meta: meta({ path: '/new.jsonl', lastActivityAt: '2026-09-02T00:00:00.000Z' }),
        pr: ready(),
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

describe('retainLaneOrder', () => {
  const tile = (path: string, phosphorId?: string) =>
    buildLaneBoard([lane({ meta: meta({ path }), phosphorId })]).lanes[0]!
  it('keeps positions through activity reordering, appends new lanes and removes deleted ones', () => {
    const first = retainLaneOrder([], [tile('/a'), tile('/b')])
    expect(retainLaneOrder(first, [tile('/b'), tile('/a')])).toBe(first)
    const next = retainLaneOrder(first, [tile('/c'), tile('/b')])
    expect(next.map((p) => p.path)).toEqual(['/b', '/c'])
  })
  it('initially puts work ahead of history, then retains its position when it becomes idle', () => {
    const active = { ...tile('/active'), state: 'running' as const }
    const idle = tile('/idle')
    const order = retainLaneOrder([], [idle, active])
    expect(order.map((p) => p.path)).toEqual(['/active', '/idle'])
    expect(retainLaneOrder(order, [idle, { ...active, state: 'idle' }])).toBe(order)
  })
  it('keeps tile identity through first save, suspension and resume', () => {
    let order = retainLaneOrder([], [tile('live-a', 'live-a'), tile('/b')])
    const key = order[0]!.key
    order = retainLaneOrder(order, [tile('/b'), tile('/saved', 'live-a')])
    expect(order[0]).toMatchObject({ key, path: '/saved' })
    order = retainLaneOrder(order, [tile('/b'), tile('/saved')])
    order = retainLaneOrder(order, [tile('/b'), tile('/saved', 'resumed')])
    expect(order[0]).toEqual({ key, path: '/saved', phosphorId: 'resumed' })
  })
})

describe('boardHeadline', () => {
  const empty = buildLaneBoard([])

  it('is null when there is nothing to say', () => {
    expect(boardHeadline(empty)).toBeNull()
  })

  it('leads with questions, then merges, then pushes, then review, then running', () => {
    expect(
      boardHeadline(buildLaneBoard([lane({ hasPendingQuestion: true }), lane({ pr: ready() })])),
    ).toBe('1 waiting on you')
    expect(
      boardHeadline(buildLaneBoard([lane({ pr: ready() }), lane({ isStreaming: true })])),
    ).toBe('1 ready to merge')
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

describe('known issue R1: the board reads a PR the way the sidebar does', () => {
  const green = { passed: 2, failed: 0, pending: 0, total: 2 }

  it('never offers merge for a PR that conflicts with its base, even approved and green', () => {
    const conflicting = pr({ mergeable: 'CONFLICTING', reviewDecision: 'APPROVED', checks: green })
    expect(classifyLane(lane({ pr: conflicting }))).toMatchObject({
      state: 'attention',
      action: 'open',
    })
  })

  it('never calls a PR with no CI "checks green" or ready to merge', () => {
    for (const reviewDecision of ['APPROVED', 'REVIEW_REQUIRED', undefined] as const) {
      for (const checks of [undefined, { passed: 0, failed: 0, pending: 0, total: 0 }]) {
        const out = classifyLane(lane({ pr: pr({ reviewDecision, checks }) }))
        expect(out?.state).not.toBe('ready')
        expect(out?.detail).not.toMatch(/checks green/)
      }
    }
  })
})
