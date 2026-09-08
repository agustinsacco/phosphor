import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { GhPullRequest } from '@shared/models'
import { usePullRequestsStore, repoPullRequests, pullRequestFor, PR_STALE_MS } from './pullRequests'

const REPO = '/repo'
const pr = (over: Partial<GhPullRequest> = {}): GhPullRequest => ({
  number: 412,
  title: 'A',
  state: 'OPEN',
  url: 'https://x/412',
  ...over,
})

let invoke: ReturnType<typeof vi.fn>

beforeEach(() => {
  usePullRequestsStore.setState({ byRepo: {}, available: undefined })
  invoke = vi.fn(async (channel: string) =>
    channel === 'gh:available' ? true : { 'feat/a': pr() },
  )
  ;(globalThis as { window?: unknown }).window = { phosphor: { invoke } }
  vi.useRealTimers()
})

describe('repoPullRequests', () => {
  it('returns one shared frozen empty value for unknown repos', () => {
    const state = usePullRequestsStore.getState()
    const a = repoPullRequests(state, '/nope')
    const b = repoPullRequests(state, '/other')
    expect(a).toBe(b)
    expect(Object.isFrozen(a)).toBe(true)
  })

  it('returns undefined for a lane with no branch', () => {
    const state = usePullRequestsStore.getState()
    expect(pullRequestFor(state, REPO, undefined)).toBeUndefined()
  })
})

describe('refresh', () => {
  it('fetches and indexes, then joins by branch', async () => {
    await usePullRequestsStore.getState().refresh(REPO)
    const state = usePullRequestsStore.getState()
    expect(pullRequestFor(state, REPO, 'feat/a')?.number).toBe(412)
    expect(pullRequestFor(state, REPO, 'feat/missing')).toBeUndefined()
  })

  it('skips the fetch entirely when gh is unavailable', async () => {
    invoke.mockImplementation(async (channel: string) =>
      channel === 'gh:available' ? false : { 'feat/a': pr() },
    )
    await usePullRequestsStore.getState().refresh(REPO)
    expect(invoke).toHaveBeenCalledTimes(1)
    expect(repoPullRequests(usePullRequestsStore.getState(), REPO).byBranch).toEqual({})
  })

  it('probes gh:available once, not per repo', async () => {
    await usePullRequestsStore.getState().refresh(REPO)
    await usePullRequestsStore.getState().refresh('/other')
    expect(invoke.mock.calls.filter(([c]) => c === 'gh:available')).toHaveLength(1)
  })

  it('is a no-op inside the stale window, and refetches when forced', async () => {
    await usePullRequestsStore.getState().refresh(REPO)
    const calls = invoke.mock.calls.length
    await usePullRequestsStore.getState().refresh(REPO)
    expect(invoke.mock.calls.length).toBe(calls)
    await usePullRequestsStore.getState().refresh(REPO, { force: true })
    expect(invoke.mock.calls.length).toBeGreaterThan(calls)
  })

  it('refetches once the slice is older than the stale window', async () => {
    await usePullRequestsStore.getState().refresh(REPO)
    const calls = invoke.mock.calls.length
    usePullRequestsStore.setState((s) => ({
      byRepo: {
        ...s.byRepo,
        [REPO]: { ...s.byRepo[REPO]!, fetchedAt: Date.now() - PR_STALE_MS - 1 },
      },
    }))
    await usePullRequestsStore.getState().refresh(REPO)
    expect(invoke.mock.calls.length).toBeGreaterThan(calls)
  })

  it('keeps the previous map when a refresh throws', async () => {
    await usePullRequestsStore.getState().refresh(REPO)
    invoke.mockRejectedValue(new Error('ipc gone'))
    await usePullRequestsStore.getState().refresh(REPO, { force: true })
    const slice = repoPullRequests(usePullRequestsStore.getState(), REPO)
    expect(slice.byBranch['feat/a']?.number).toBe(412)
    expect(slice.loading).toBe(false)
  })

  it('ignores an empty repo path', async () => {
    await usePullRequestsStore.getState().refresh('')
    expect(invoke).not.toHaveBeenCalled()
  })
})
