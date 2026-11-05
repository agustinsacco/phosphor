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

const invoke = vi.fn<(channel: string, repo: string) => Promise<unknown>>()

beforeEach(() => {
  usePullRequestsStore.setState({ byRepo: {}, available: undefined })
  invoke.mockReset()
  invoke.mockImplementation(async (channel: string) =>
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
  it('queries the Host even when this client has no gh installed', async () => {
    usePullRequestsStore.setState({ available: false })
    const key = 'host:00000000-0000-4000-8000-000000000001/repo:1234567890abcdef'
    await usePullRequestsStore.getState().refresh(key)
    expect(invoke).toHaveBeenCalledWith('gh:prsForRepo', key)
    expect(pullRequestFor(usePullRequestsStore.getState(), key, 'feat/a')?.number).toBe(412)
  })
  it('does not restore a removed repository from an in-flight response', async () => {
    let finish!: (value: unknown) => void
    invoke.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const key = 'host:00000000-0000-4000-8000-000000000001/repo:1234567890abcdef'
    const pending = usePullRequestsStore.getState().refresh(key)
    usePullRequestsStore.getState().remove(key)
    finish({ byBranch: { 'feat/a': pr() }, complete: true })
    await pending
    expect(usePullRequestsStore.getState().byRepo[key]).toBeUndefined()
  })

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

  it('records a failed repo query without a successful refresh', async () => {
    invoke.mockImplementation(async (channel: string) => (channel === 'gh:available' ? true : null))
    await usePullRequestsStore.getState().refresh(REPO)
    const slice = repoPullRequests(usePullRequestsStore.getState(), REPO)
    expect(slice.fetchedAt).toBe(0)
    expect(slice.failed).toBe(true)
    expect(slice.loading).toBe(false)
    const calls = invoke.mock.calls.length
    await usePullRequestsStore.getState().refresh(REPO)
    expect(invoke).toHaveBeenCalledTimes(calls)
  })

  it('preserves known PRs after a failed query', async () => {
    await usePullRequestsStore.getState().refresh(REPO)
    expect(repoPullRequests(usePullRequestsStore.getState(), REPO).failed).toBe(false)
    invoke.mockResolvedValue(null)
    await usePullRequestsStore.getState().refresh(REPO, { force: true })
    const slice = repoPullRequests(usePullRequestsStore.getState(), REPO)
    expect(slice.byBranch['feat/a']?.number).toBe(412)
    expect(slice.failed).toBe(true)
  })

  it('adds a truncated listing to the known PRs', async () => {
    await usePullRequestsStore.getState().refresh(REPO)
    invoke.mockResolvedValue({ byBranch: { 'feat/b': pr({ number: 7 }) }, complete: false })
    await usePullRequestsStore.getState().refresh(REPO, { force: true })
    const slice = repoPullRequests(usePullRequestsStore.getState(), REPO)
    expect(slice.byBranch['feat/a']?.number).toBe(412)
    expect(slice.byBranch['feat/b']?.number).toBe(7)
  })

  it('replaces the known PRs with a complete listing', async () => {
    await usePullRequestsStore.getState().refresh(REPO)
    invoke.mockResolvedValue({ byBranch: {}, complete: true })
    await usePullRequestsStore.getState().refresh(REPO, { force: true })
    expect(repoPullRequests(usePullRequestsStore.getState(), REPO).byBranch).toEqual({})
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

it('re-probes missing local gh on a later attempt so installation can recover without restart', async () => {
  invoke.mockResolvedValueOnce(false)
  await usePullRequestsStore.getState().refresh(REPO)
  expect(repoPullRequests(usePullRequestsStore.getState(), REPO).failed).toBe(true)
  await usePullRequestsStore.getState().refresh(REPO, { force: true })
  expect(pullRequestFor(usePullRequestsStore.getState(), REPO, 'feat/a')?.number).toBe(412)
  expect(repoPullRequests(usePullRequestsStore.getState(), REPO).failed).toBe(false)
})
