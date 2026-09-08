import { describe, it, expect } from 'vitest'
import type { GhPullRequest, GitInfo, SessionMeta } from '@shared/models'
import { classifyLane, summarizePreflight, describeWarnings } from './deletePreflight'

const meta = (over: Partial<SessionMeta> = {}): SessionMeta =>
  ({ path: '/s/a.jsonl', cwd: '/repo/.phosphor/worktrees/a', ...over }) as SessionMeta

const git = (over: Partial<GitInfo> = {}): GitInfo => ({
  isRepo: true,
  branch: 'phosphor/a',
  isWorktree: true,
  mainRepoPath: '/repo',
  ...over,
})

const lane = (
  over: Parameters<typeof classifyLane>[0] extends never
    ? never
    : Partial<Parameters<typeof classifyLane>[0]> = {},
) =>
  classifyLane({
    meta: meta(),
    title: 'Lane',
    marker: '🚀',
    git: git(),
    isLive: false,
    isStreaming: false,
    ...over,
  })

const pr = (state: GhPullRequest['state']): GhPullRequest => ({
  number: 1,
  title: 'p',
  state,
  url: 'https://x/1',
})

describe('classifyLane', () => {
  it('refuses only a streaming lane, not a merely live one', () => {
    expect(lane({ isLive: true, isStreaming: false }).blocker).toBeUndefined()
    expect(lane({ isLive: true, isStreaming: true }).blocker).toBe('running')
  })

  it('warns on uncommitted and unpushed work', () => {
    expect(lane({ git: git({ dirtyCount: 3 }) }).warnings).toContain('uncommitted')
    expect(lane({ git: git({ ahead: 2 }) }).warnings).toContain('unpushed')
  })

  it('warns on an open or draft PR, but not a finished one', () => {
    expect(lane({ pr: pr('OPEN') }).warnings).toContain('open-pr')
    expect(lane({ pr: pr('DRAFT') }).warnings).toContain('open-pr')
    expect(lane({ pr: pr('MERGED') }).warnings).toEqual([])
    expect(lane({ pr: pr('CLOSED') }).warnings).toEqual([])
  })

  it('offers a worktree path only for a real linked worktree', () => {
    expect(lane().worktreePath).toBe('/repo/.phosphor/worktrees/a')
    // A session in the main checkout has no directory of its own to remove —
    // offering to would delete the user's actual repo.
    expect(lane({ git: git({ isWorktree: false }) }).worktreePath).toBeUndefined()
  })

  it('treats a lane with no git info as clean and unremovable', () => {
    const plain = lane({ git: undefined })
    expect(plain.warnings).toEqual([])
    expect(plain.worktreePath).toBeUndefined()
  })
})

describe('summarizePreflight', () => {
  it('splits blocked from deletable and does not count blocked lanes', () => {
    const summary = summarizePreflight([
      lane({ meta: meta({ path: '/a' }) }),
      lane({ meta: meta({ path: '/b' }), isStreaming: true }),
    ])
    expect(summary.deletable.map((l) => l.path)).toEqual(['/a'])
    expect(summary.blocked.map((l) => l.path)).toEqual(['/b'])
  })

  it('ignores warnings that only a blocked lane carries', () => {
    // The blocked lane is not being deleted, so its dirty tree is not a reason
    // to make the user acknowledge anything.
    const summary = summarizePreflight([
      lane({ meta: meta({ path: '/a' }) }),
      lane({ meta: meta({ path: '/b' }), isStreaming: true, git: git({ dirtyCount: 9 }) }),
    ])
    expect(summary.needsAcknowledgement).toBe(false)
  })

  it('deduplicates warnings across lanes', () => {
    const summary = summarizePreflight([
      lane({ meta: meta({ path: '/a' }), git: git({ dirtyCount: 1 }) }),
      lane({ meta: meta({ path: '/b' }), git: git({ dirtyCount: 2 }) }),
    ])
    expect(summary.warnings).toEqual(['uncommitted'])
    expect(summary.needsAcknowledgement).toBe(true)
  })

  it('needs no acknowledgement for a clean selection', () => {
    expect(summarizePreflight([lane()]).needsAcknowledgement).toBe(false)
  })

  it('counts only worktree lanes that know their main repo', () => {
    const summary = summarizePreflight([
      lane({ meta: meta({ path: '/a' }) }),
      lane({ meta: meta({ path: '/b' }), git: git({ isWorktree: false }) }),
      lane({ meta: meta({ path: '/c' }), git: git({ mainRepoPath: undefined }) }),
    ])
    expect(summary.worktreeCount).toBe(1)
  })
})

describe('describeWarnings', () => {
  it('lists only what applies', () => {
    expect(describeWarnings(['uncommitted', 'open-pr'])).toBe('uncommitted changes, an open PR')
    expect(describeWarnings([])).toBe('')
  })
})
