import { describe, expect, it } from 'vitest'
import { sessionSubtitle } from './sessionSubtitle'
import type { GitInfo, SessionMeta } from '@shared/models'

const meta = (overrides: Partial<SessionMeta> = {}): SessionMeta => ({
  path: '/s.jsonl',
  sessionId: 's',
  cwd: '/repo',
  createdAt: '2026-08-09T00:00:00.000Z',
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
  mtimeMs: Date.now() - 60_000,
  lastActivityAt: '2026-08-09T00:01:00.000Z',
  ...overrides,
})

const git = (overrides: Partial<GitInfo> = {}): GitInfo => ({ isRepo: true, ...overrides })

describe('sessionSubtitle', () => {
  it('always starts with the timestamp', () => {
    const segments = sessionSubtitle(meta(), undefined)
    expect(segments[0]?.key).toBe('time')
    expect(segments).toHaveLength(1)
  })

  it('adds branch and dirty count when available', () => {
    const segments = sessionSubtitle(
      meta({ cost: 1.244 }),
      git({ branch: 'fix/chat-ux', dirtyCount: 3 }),
    )
    expect(segments.map((s) => s.key)).toEqual(['time', 'branch', 'dirty'])
    expect(segments.find((s) => s.key === 'branch')).toMatchObject({
      text: 'fix/chat-ux',
      truncate: true,
    })
    expect(segments.find((s) => s.key === 'dirty')?.text).toBe('±3')
  })

  it('marks worktree sessions', () => {
    const segments = sessionSubtitle(meta(), git({ isWorktree: true, branch: 'task-1' }))
    expect(segments.map((s) => s.key)).toEqual(['time', 'worktree', 'branch'])
  })

  it('omits git segments outside a repo and zero values', () => {
    const segments = sessionSubtitle(meta({ cost: 0 }), { isRepo: false })
    expect(segments.map((s) => s.key)).toEqual(['time'])
    const clean = sessionSubtitle(meta(), git({ branch: 'main', dirtyCount: 0 }))
    expect(clean.map((s) => s.key)).toEqual(['time', 'branch'])
  })

  it('never carries spend, however large', () => {
    const rich = sessionSubtitle(meta({ cost: 90.92 }), git({ branch: 'main' }))
    const tiny = sessionSubtitle(meta({ cost: 0.0042 }), undefined)
    expect(rich.map((s) => s.key)).toEqual(['time', 'branch'])
    expect(tiny.map((s) => s.key)).toEqual(['time'])
  })
})
