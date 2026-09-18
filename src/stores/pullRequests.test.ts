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
    channel === 'gh:available' ? true : { byBranch: { 'feat/a': pr() }, complete: true },
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
      channel === 'gh:available' ? false : { byBranch: { 'feat/a': pr() }, complete: true },
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
        [REPO]: { ...s.byRepo[REPO]!, attemptedAt: Date.now() - PR_STALE_MS - 1 },
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

  it('keeps independent PR state for the same branch in different workspaces', async () => {
    invoke.mockImplementation(async (channel: string, repo: string) =>
      channel === 'gh:available'
        ? true
        : { byBranch: { 'feat/a': pr({ number: repo === REPO ? 412 : 17 }) }, complete: true },
    )
    await Promise.all([
      usePullRequestsStore.getState().refresh(REPO),
      usePullRequestsStore.getState().refresh('/another-org/service'),
    ])
    const state = usePullRequestsStore.getState()
    expect(pullRequestFor(state, REPO, 'feat/a')?.number).toBe(412)
    expect(pullRequestFor(state, '/another-org/service', 'feat/a')?.number).toBe(17)
  })

  it('does not confirm absence when gh is installed but the repo query fails', async () => {
    invoke.mockImplementation(async (channel: string) => (channel === 'gh:available' ? true : null))
    await usePullRequestsStore.getState().refresh(REPO)
    const slice = repoPullRequests(usePullRequestsStore.getState(), REPO)
    expect(slice.fetchedAt).toBe(0)
    expect(slice.complete).toBe(false)
    expect(slice.loading).toBe(false)
    const calls = invoke.mock.calls.length
    await usePullRequestsStore.getState().refresh(REPO)
    expect(invoke).toHaveBeenCalledTimes(calls)
  })

  it('preserves known PRs but revokes absence after a failed query', async () => {
    await usePullRequestsStore.getState().refresh(REPO)
    expect(repoPullRequests(usePullRequestsStore.getState(), REPO).complete).toBe(true)
    invoke.mockResolvedValue(null)
    await usePullRequestsStore.getState().refresh(REPO, { force: true })
    const slice = repoPullRequests(usePullRequestsStore.getState(), REPO)
    expect(slice.byBranch['feat/a']?.number).toBe(412)
    expect(slice.complete).toBe(false)
  })

  it('does not confirm absence for a truncated listing', async () => {
    usePullRequestsStore.setState({ available: true })
    invoke.mockResolvedValue({ byBranch: { 'feat/a': pr() }, complete: false })
    await usePullRequestsStore.getState().refresh(REPO)
    const slice = repoPullRequests(usePullRequestsStore.getState(), REPO)
    expect(slice.byBranch['feat/a']?.number).toBe(412)
    expect(slice.complete).toBe(false)
  })

  it('confirms absence only after a successful complete listing', async () => {
    usePullRequestsStore.setState({ available: true })
    invoke.mockResolvedValue({ byBranch: {}, complete: true })
    await usePullRequestsStore.getState().refresh(REPO)
    expect(repoPullRequests(usePullRequestsStore.getState(), REPO).complete).toBe(true)
  })

  it('coalesces concurrent refreshes even before availability resolves', async () => {
    await Promise.all([
      usePullRequestsStore.getState().refresh(REPO),
      usePullRequestsStore.getState().refresh(REPO),
    ])
    expect(invoke.mock.calls.filter(([c]) => c === 'gh:prsForRepo')).toHaveLength(1)
  })

  it('ignores an empty repo path', async () => {
    await usePullRequestsStore.getState().refresh('')
    expect(invoke).not.toHaveBeenCalled()
  })
})
