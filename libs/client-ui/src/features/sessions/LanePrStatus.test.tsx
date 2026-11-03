// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { GhPullRequest, GhRepoPullRequests, GitInfo } from '@shared/models'
import { remotePrKey } from '@shared/host-protocol-github'
import {
  createFakePhosphor,
  installFakePhosphor,
} from '../../../../../apps/desktop/test/renderer/helpers/fakePhosphor'
import { useSessionsStore } from '@/stores/sessions'
import { useChatStore } from '@/stores/chat'
import { useLanePrefsStore } from '@/stores/lanePrefs'
import { useLayoutStore } from '@/stores/layout'
import { usePullRequestsStore } from '@/stores/pullRequests'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { mockRemoteHosts, mockRemoteInfo, MOCK_HOST_ID } from '@/dev/mockRemoteLanes'
import { LanePrStatus } from './LanePrStatus'

let root: Root
let container: HTMLDivElement
let restore: () => void
let dispose: () => void
const git: GitInfo = { isRepo: true, isWorktree: true, mainRepoPath: '/repo', branch: 'feature' }
const pr: GhPullRequest = {
  number: 42,
  title: 'Improve lanes',
  state: 'OPEN',
  url: 'https://github.com/example/repo/pull/42',
  checks: { passed: 2, failed: 0, pending: 0, total: 2 },
  reviewDecision: 'REVIEW_REQUIRED',
  mergeable: 'MERGEABLE',
}
const read = vi.fn(async (_repo: string): Promise<GhRepoPullRequests> => ({
  byBranch: { feature: pr },
  complete: true,
}))
const external = vi.fn(async (_url: string) => {})
function seed(value: GhPullRequest | undefined, complete = true) {
  usePullRequestsStore.setState({
    byRepo: {
      '/repo': {
        byBranch: value ? { feature: value } : {},
        complete,
        attemptedAt: Date.now(),
        fetchedAt: Date.now(),
        loading: false,
      },
    },
  })
}
const pill = (): HTMLButtonElement | null =>
  container.querySelector('[data-testid="lane-pr-status"]')
const detail = () => document.querySelector('[aria-label="Pull request details"]')
const button = (name: string) =>
  [...document.querySelectorAll('button')].find((b) => b.textContent === name)!

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.useFakeTimers()
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
  useSessionsStore.setState({
    activeSessionId: 'a',
    live: {
      a: { phosphorId: 'a', workspacePath: '/repo/wt' },
      b: { phosphorId: 'b', workspacePath: '/repo/wt-2' },
    },
    gitByCwd: { '/repo/wt': git, '/repo/wt-2': git },
  })
  useChatStore.setState({ sessions: {} })
  useLayoutStore.setState({ sidebarVisible: false })
  useLanePrefsStore.getState().applyLanePrefs({ prStatus: true })
  usePullRequestsStore.setState({ byRepo: {}, available: true })
  useRemoteLanesStore.setState({ hosts: {}, filter: 'local' })
  read.mockReset().mockResolvedValue({ byBranch: { feature: pr }, complete: true })
  external.mockReset().mockResolvedValue(undefined)
  const fake = createFakePhosphor({
    'gh:prsForRepo': read,
    'git:infoBatch': async () => ({ '/repo/wt': git, '/repo/wt-2': git }),
    'app:openExternal': external,
  })
  restore = installFakePhosphor(fake)
  dispose = fake.dispose
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  restore()
  dispose()
  vi.restoreAllMocks()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

it.each([
  ['open', { state: 'OPEN' }],
  ['approved', { reviewDecision: 'APPROVED' }],
  ['failing', { checks: { passed: 1, failed: 1, pending: 0, total: 2 } }],
  ['pending', { checks: { passed: 0, failed: 0, pending: 2, total: 2 } }],
  ['blocked', { reviewDecision: 'CHANGES_REQUESTED' }],
  ['conflict', { mergeable: 'CONFLICTING' }],
  ['draft', { state: 'DRAFT' }],
  ['merged', { state: 'MERGED' }],
  ['closed', { state: 'CLOSED' }],
] as const)('renders the shared %s variant as an accessible button', async (variant, patch) => {
  seed({ ...pr, ...patch })
  await act(async () => root.render(<LanePrStatus sessionId="a" />))
  expect(pill()?.tagName).toBe('BUTTON')
  expect(pill()?.tabIndex).toBe(0)
  expect(pill()?.getAttribute('data-variant')).toBe(variant)
  expect(pill()?.getAttribute('aria-label')).toContain('#42 Improve lanes')
})

it('opens details with keyboard focus, names facts independently of green, refreshes and restores focus on Escape', async () => {
  seed(pr)
  await act(async () => root.render(<LanePrStatus sessionId="a" />))
  pill()!.focus()
  // Native buttons handle Enter/Space; Playwright exercises actual key activation.
  await act(async () => pill()!.click())
  expect(pill()?.getAttribute('aria-expanded')).toBe('true')
  expect(document.activeElement).toBe(button('Open on GitHub ↗'))
  expect(detail()?.textContent).toContain('State: open')
  expect(detail()?.textContent).toContain('2 passed · 0 failed · 0 running · 2 total')
  expect(detail()?.textContent).toContain('Review: required')
  expect(detail()?.textContent).not.toContain('approved')
  expect(detail()?.textContent).toContain('Conflicts: none reported')
  expect(detail()?.textContent).toContain('Last successful app refresh: 0s ago')
  await act(async () => button('Open on GitHub ↗').click())
  expect(external).toHaveBeenCalledWith(pr.url)
  await act(async () => button('Refresh').click())
  expect(read).toHaveBeenCalledExactlyOnceWith('/repo', { branches: ['feature'], force: true })
  await act(async () =>
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
  )
  expect(detail()).toBeNull()
  expect(document.activeElement).toBe(pill())
})

it('retains a known PR on refresh failure, reports attempt/data age, then recovers', async () => {
  seed(pr)
  await act(async () => root.render(<LanePrStatus sessionId="a" />))
  await act(async () => pill()!.click())
  read.mockRejectedValueOnce(new Error('offline'))
  await act(async () => vi.advanceTimersByTimeAsync(60_001))
  expect(pill()?.textContent).toContain('#42')
  expect(detail()?.textContent).toContain('Last app attempt failed (0s ago)')
  expect(detail()?.textContent).toContain('Last successful app refresh: 60s ago')
  await act(async () => vi.advanceTimersByTimeAsync(60_000))
  expect(detail()?.textContent).not.toContain('failed (')
  expect(detail()?.textContent).toContain('Last successful app refresh: 0s ago')
})

it('renders unavailable details honestly for identity-only results and link failures', async () => {
  seed({ number: pr.number, title: pr.title, state: pr.state, url: pr.url, checks: null })
  external.mockRejectedValueOnce(new Error('browser refused'))
  await act(async () => root.render(<LanePrStatus sessionId="a" />))
  expect(pill()?.textContent).toBe('#42')
  await act(async () => pill()!.click())
  expect(detail()?.textContent).toContain('Checks: unavailable')
  expect(detail()?.textContent).toContain('Review: unavailable')
  expect(detail()?.textContent).toContain('Conflicts: unavailable')
  await act(async () => button('Open on GitHub ↗').click())
  expect(detail()?.querySelector('[role="alert"]')?.textContent).toContain('Could not open GitHub')
})

it('infers no PR only for a complete worktree listing, not truncated data or ordinary branches', async () => {
  seed(undefined)
  await act(async () => root.render(<LanePrStatus sessionId="a" />))
  expect(pill()?.textContent).toBe('↑ no PR')
  await act(async () => seed(undefined, false))
  expect(pill()?.textContent).toBe('PR ?')
  await act(async () => {
    seed(undefined)
    useSessionsStore.setState({ gitByCwd: { '/repo/wt': { ...git, isWorktree: false } } })
  })
  expect(pill()?.textContent).toBe('PR ?')
})

it('shows loading and respects the PR status preference', async () => {
  let finish!: (value: { byBranch: { feature: GhPullRequest }; complete: boolean }) => void
  read.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  await act(async () => root.render(<LanePrStatus sessionId="a" />))
  expect(pill()?.textContent).toBe('PR …')
  await act(async () => pill()!.click())
  expect(detail()?.textContent).toContain('Refreshing repository…')
  expect(button('Refreshing…').disabled).toBe(true)
  await act(async () => finish({ byBranch: { feature: pr }, complete: true }))
  await act(async () => useLanePrefsStore.getState().applyLanePrefs({ prStatus: false }))
  expect(pill()).toBeNull()
  expect(detail()).toBeNull()
})

it('polls the active collapsed repo and coalesces same-repo lane switching without another workspace', async () => {
  await act(async () => root.render(<LanePrStatus sessionId="a" />))
  await act(async () => root.render(<LanePrStatus sessionId="b" />))
  expect(read).toHaveBeenCalledExactlyOnceWith('/repo', { branches: ['feature'] })
  await act(async () => vi.advanceTimersByTimeAsync(120_001))
  expect(read).toHaveBeenCalledTimes(3)
  expect(read.mock.calls.every(([repo]) => repo === '/repo')).toBe(true)
})

it('uses Host repository/branch identity even with a local machine filter and local gh unavailable', async () => {
  const hosts = structuredClone(mockRemoteHosts)
  const host = hosts[MOCK_HOST_ID]!
  host.capabilities.push('workspaces.read')
  host.lanes[0] = { ...host.lanes[0]!, branch: 'remote-feature' }
  const key = remotePrKey(MOCK_HOST_ID, host.lanes[0]!.repositoryId)
  useRemoteLanesStore.setState({ hosts, filter: 'local' })
  useSessionsStore.setState({ live: { remote: { ...mockRemoteInfo, phosphorId: 'remote' } } })
  usePullRequestsStore.setState({ available: false })
  read.mockResolvedValueOnce({
    byBranch: { 'remote-feature': { ...pr, number: 99 } },
    complete: true,
  })
  await act(async () => root.render(<LanePrStatus sessionId="remote" />))
  expect(read).toHaveBeenCalledExactlyOnceWith(key, { branches: ['remote-feature'] })
  expect(pill()?.textContent).toContain('#99')
  await act(async () => pill()!.click())
  expect(detail()?.textContent).toContain(
    'Host may reuse its repository cache for up to 60 seconds',
  )
  await act(async () => button('Refresh').click())
  expect(read.mock.lastCall).toEqual([key, { branches: ['remote-feature'], force: true }])
})

it('requests a stale refresh when activating another lane in the same repository', async () => {
  await act(async () => root.render(<LanePrStatus sessionId="a" />))
  usePullRequestsStore.setState((s) => ({
    byRepo: { '/repo': { ...s.byRepo['/repo']!, attemptedAt: Date.now() - 60_001 } },
  }))
  await act(async () => root.render(<LanePrStatus sessionId="b" />))
  expect(read).toHaveBeenCalledTimes(2)
})

it('uses branch coverage for absence, stale status and upstream age rather than another page refresh', async () => {
  seed(pr, false)
  usePullRequestsStore.setState((s) => ({
    byRepo: {
      '/repo': {
        ...s.byRepo['/repo']!,
        coverage: {
          feature: {
            state: 'unavailable',
            checkedAt: Date.now() - 120_000,
            attemptedAt: Date.now() - 10_000,
          },
          other: { state: 'found', checkedAt: Date.now(), attemptedAt: Date.now() },
        },
      },
    },
  }))
  await act(async () => root.render(<LanePrStatus sessionId="a" />))
  await act(async () => pill()!.click())
  expect(detail()?.textContent).toContain('Last upstream check: 120s ago')
  expect(detail()?.textContent).toContain('Last upstream attempt failed (10s ago)')
  expect(detail()?.textContent).toContain('Showing stale status')
  await act(async () =>
    usePullRequestsStore.setState((s) => ({
      byRepo: {
        '/repo': {
          ...s.byRepo['/repo']!,
          byBranch: {},
          coverage: {
            feature: { state: 'absent', checkedAt: Date.now(), attemptedAt: Date.now() },
          },
        },
      },
    })),
  )
  expect(pill()?.textContent).toContain('no PR')
  await act(async () =>
    usePullRequestsStore.setState((s) => ({
      byRepo: {
        '/repo': {
          ...s.byRepo['/repo']!,
          coverage: {},
        },
      },
    })),
  )
  expect(pill()?.textContent).toBe('PR ?')
})
