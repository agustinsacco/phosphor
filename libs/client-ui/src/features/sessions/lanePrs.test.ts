import { describe, expect, it } from 'vitest'
import type { GhPullRequest, GhPrSummary, LanePrSignals } from '@shared/models'
import type { RepoPullRequests } from '@/stores/pullRequests'
import { laneStatusRefs, resolveLanePrs } from './lanePrs'

const ref = (number: number, repo = 'repo') => ({
  host: 'github.com',
  owner: 'Example',
  repo,
  number,
})
const key = (number: number, repo = 'repo') => `github.com/example/${repo}#${number}`
const discovered = (number: number, state: GhPullRequest['state'] = 'OPEN'): GhPullRequest => ({
  number,
  title: `PR ${number}`,
  state,
  url: `https://github.com/Example/repo/pull/${number}`,
})
const slice = (byBranch: Record<string, GhPullRequest>): RepoPullRequests => ({
  byBranch,
  fetchedAt: 1,
  attemptedAt: 1,
  loading: false,
})
const signals = (patch: Partial<LanePrSignals>): LanePrSignals => ({
  opened: [],
  branches: [],
  reviewing: [],
  mentioned: [],
  pinned: [],
  hidden: [],
  ...patch,
})

describe('resolveLanePrs', () => {
  it('owns what the lane opened, pushed, checked out and pinned, once each', () => {
    const prs = resolveLanePrs({
      signals: signals({
        opened: [ref(10), ref(5, 'dbt')],
        branches: ['agustin/a'],
        pinned: [ref(10), ref(30)],
      }),
      branch: 'checkout',
      slice: slice({ 'agustin/a': discovered(20), checkout: discovered(10) }),
      status: {},
    })
    // PRs still waiting for their first read sort after the ones with status.
    expect(prs.owned.map((p) => [p.key, p.source])).toEqual([
      [key(20), 'branch'],
      [key(10), 'opened'],
      [key(30), 'pinned'],
      [key(5, 'dbt'), 'opened'],
    ])
    // Discovery's status shows at once; a PR read only by number waits for its summary.
    expect(prs.owned.find((p) => p.number === 20)?.pr?.title).toBe('PR 20')
    expect(prs.owned.find((p) => p.number === 5)?.pr).toBeUndefined()
    expect(laneStatusRefs(prs)).toHaveLength(4)
  })

  it('orders by what needs you first', () => {
    const merged = { ...discovered(1, 'MERGED') }
    const failing = { ...discovered(2), checks: { passed: 0, failed: 1, pending: 0, total: 1 } }
    const prs = resolveLanePrs({
      signals: signals({ branches: ['a', 'b'] }),
      slice: slice({ a: merged, b: failing }),
      status: {},
    })
    expect(prs.owned.map((p) => p.number)).toEqual([2, 1])
  })

  it('keeps hidden PRs out, and suggestions apart from what the lane owns', () => {
    const prs = resolveLanePrs({
      signals: signals({
        opened: [ref(1), ref(2)],
        hidden: [ref(2), ref(4)],
        reviewing: [ref(3), ref(1)],
        reviewingHere: [7],
        mentioned: [ref(1), ref(3), ref(4), ref(8)],
      }),
      slice: slice({ other: discovered(99) }),
      status: {},
    })
    expect(prs.owned.map((p) => p.number)).toEqual([1])
    expect(prs.reviewing.map((p) => p.key)).toEqual([key(3), key(7)])
    expect(prs.mentioned.map((p) => p.key)).toEqual([key(8)])
    expect(prs.home).toEqual({ host: 'github.com', owner: 'Example', repo: 'repo' })
    expect(laneStatusRefs(prs, true)).toHaveLength(4)
  })

  it('drops only a PR GitHub says does not exist, and keeps a failed read marked stale', () => {
    const summary = {
      ...discovered(1),
      checkRuns: [],
      approvedBy: [],
      changesRequestedBy: [],
      waitingOn: [],
      threads: null,
    } as unknown as GhPrSummary
    const prs = resolveLanePrs({
      signals: signals({ opened: [ref(1), ref(2)] }),
      slice: slice({}),
      status: {
        [key(1)]: {
          summary,
          coverage: { state: 'unavailable', checkedAt: 1, attemptedAt: 2 },
          attemptedAt: 2,
          fetchedAt: 1,
        },
        [key(2)]: {
          coverage: { state: 'absent', checkedAt: 1, attemptedAt: 1 },
          attemptedAt: 1,
          fetchedAt: 1,
        },
      },
    })
    expect(prs.owned.map((p) => [p.number, p.stale])).toEqual([[1, true]])
  })

  it('shows a discovered PR whose URL names no repository, without reading it by number', () => {
    const odd = { ...discovered(7), url: 'https://git.example.test/7' }
    const prs = resolveLanePrs({ branch: 'b', slice: slice({ b: odd }), status: {} })
    expect(prs.owned.map((p) => [p.number, p.ref])).toEqual([[7, undefined]])
    expect(laneStatusRefs(prs)).toEqual([])
  })
})
