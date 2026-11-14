// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { GhPrRead, GhPullRequest, GhRepoPullRequests, GitInfo } from '@shared/models'
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
import { usePrStatusStore } from '@/stores/prStatus'
import { usePrDetailStore } from '@/stores/prDetail'
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
// By number, GitHub says nothing new: the pill reads what discovery saw.
const summaries = vi.fn(async (): Promise<GhPrRead> => ({ byKey: {}, coverage: {} }))
const external = vi.fn(async (_url: string) => {})
function seed(value: GhPullRequest | undefined) {
  usePullRequestsStore.setState({
    byRepo: {
      '/repo': {
        byBranch: value ? { feature: value } : {},
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
  [...document.querySelectorAll('button')].find(
    (b) => b.getAttribute('aria-label') === name || b.textContent === name,
  )!
const rail = () =>
  [...(pill()?.querySelectorAll('[data-testid="pr-rail"] i') ?? [])].map((i) =>
    i.getAttribute('data-state'),
  )

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
  usePrStatusStore.setState({ byKey: {} })
  usePrDetailStore.setState({ byKey: {} })
  useRemoteLanesStore.setState({ hosts: {}, filter: 'local' })
  read.mockReset().mockResolvedValue({ byBranch: { feature: pr }, complete: true })
  summaries.mockReset().mockResolvedValue({ byKey: {}, coverage: {} })
  external.mockReset().mockResolvedValue(undefined)
  const fake = createFakePhosphor({
    'gh:prsForRepo': read,
    'gh:prSummaries': summaries,
    'gh:prDetail': async () => null,
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
  ['review', {}, 'Waiting for review', ['done', 'done', 'wait', 'wait']],
  [
    'ready',
    { reviewDecision: 'APPROVED' },
    'Approved, checks green: ready to merge',
    ['done', 'done', 'done', 'ready'],
  ],
  [
    'failing',
    { checks: { passed: 1, failed: 1, pending: 0, total: 2 } },
    '1 check failing',
    ['done', 'fail', 'wait', 'wait'],
  ],
  [
    'pending',
    { checks: { passed: 0, failed: 0, pending: 2, total: 2 } },
    'Checks running, 2 left',
    ['done', 'run', 'wait', 'wait'],
  ],
  [
    'blocked',
    { reviewDecision: 'CHANGES_REQUESTED' },
    'Changes requested',
    ['done', 'done', 'fail', 'wait'],
  ],
  [
    'conflict',
    { mergeable: 'CONFLICTING' },
    'Conflicts with its base',
    ['done', 'done', 'wait', 'fail'],
  ],
  ['draft', { state: 'DRAFT' }, 'Draft', ['part', 'done', 'wait', 'wait']],
  ['merged', { state: 'MERGED' }, 'Merged', ['done', 'done', 'done', 'done']],
  ['closed', { state: 'CLOSED' }, 'Closed without merging', ['done', 'done', 'wait', 'fail']],
] as const)(
  'renders the %s verdict tone with its stage rail as an accessible button',
  async (tone, patch, headline, stages) => {
    seed({ ...pr, ...patch })
    await act(async () => root.render(<LanePrStatus sessionId="a" />))
    expect(pill()?.tagName).toBe('BUTTON')
    expect(pill()?.tabIndex).toBe(0)
    expect(pill()?.getAttribute('data-variant')).toBe(tone)
    expect(pill()?.getAttribute('aria-label')).toBe(`Pull request #42: ${headline}.`)
    expect(pill()?.textContent).toBe('#42')
    expect(rail()).toEqual(stages)
  },
)

it('opens the inspector on the lead PR, opens GitHub, refreshes by force and restores focus on Escape', async () => {
  seed(pr)
  await act(async () => root.render(<LanePrStatus sessionId="a" />))
  pill()!.focus()
  // Native buttons handle Enter/Space; Playwright exercises actual key activation.
  await act(async () => pill()!.click())
  expect(pill()?.getAttribute('aria-expanded')).toBe('true')
  const selected = document.querySelector('[role="option"][aria-selected="true"]')
  expect(document.activeElement).toBe(selected)
  expect(selected?.textContent).toContain('#42')
  expect(detail()?.textContent).toContain('Improve lanes')
  expect(detail()?.textContent).toContain('In review')
  // Discovery alone carries counts, not people: each fact says so on its own.
  expect(detail()?.textContent).toContain('2 passed, 0 failed, 0 running')
  expect(detail()?.textContent).toContain('Review required')
  expect(detail()?.textContent).toContain('No conflicts')
  await act(async () => button('Open on GitHub').click())
  expect(external).toHaveBeenCalledWith(pr.url)
  await act(async () => button('Refresh').click())
  expect(read).toHaveBeenLastCalledWith('/repo', { branches: ['feature'], force: true })
  expect(summaries).toHaveBeenLastCalledWith(
    [{ host: 'github.com', owner: 'example', repo: 'repo', number: 42 }],
    { force: true },
  )
  await act(async () =>
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
  )
  expect(detail()).toBeNull()
  expect(document.activeElement).toBe(pill())
})

it('retains a known PR when its read fails, says it is stale, then recovers', async () => {
  seed(pr)
  await act(async () => root.render(<LanePrStatus sessionId="a" />))
  await act(async () => pill()!.click())
  expect(detail()?.textContent).toContain('checked 0s ago')
  summaries.mockRejectedValueOnce(new Error('offline'))
  await act(async () => button('Refresh').click())
  expect(pill()?.textContent).toContain('#42')
  const stale = document.querySelector('[data-testid="pr-inspector-stale"]')
  expect(stale?.textContent).toBe('stale')
  expect(detail()?.textContent).toContain(
    'The last read failed 0s ago. Showing status from 0s ago.',
  )
  await act(async () => button('Refresh').click())
  expect(document.querySelector('[data-testid="pr-inspector-stale"]')).toBeNull()
  expect(detail()?.textContent).toContain('checked 0s ago')
})

it('says what is unavailable for identity-only results and keeps a link failure visible', async () => {
  seed({ number: pr.number, title: pr.title, state: pr.state, url: pr.url, checks: null })
  external.mockRejectedValueOnce(new Error('browser refused'))
  await act(async () => root.render(<LanePrStatus sessionId="a" />))
  expect(pill()?.textContent).toBe('#42')
  await act(async () => pill()!.click())
  expect(detail()?.textContent).toContain('ChecksUnavailable')
  expect(detail()?.textContent).toContain('ReviewUnavailable')
  expect(detail()?.textContent).toContain('BranchUnavailable')
  await act(async () => button('Open on GitHub').click())
  expect(detail()?.querySelector('[role="alert"]')?.textContent).toContain('Could not open GitHub')
  expect(detail()).not.toBeNull()
})

it('shows nothing for a lane without a PR or on an ordinary branch', async () => {
  seed(undefined)
  await act(async () => root.render(<LanePrStatus sessionId="a" />))
  expect(pill()).toBeNull()
  await act(async () => {
    seed(undefined)
    useSessionsStore.setState({ gitByCwd: { '/repo/wt': { ...git, isWorktree: false } } })
  })
  expect(pill()).toBeNull()
  // The listing keeps polling, so a PR opened later still appears.
  await act(async () => seed(pr))
  expect(pill()?.textContent).toBe('#42')
})

it('shows nothing while the first listing loads, then the PR, and respects the preference', async () => {
  let finish!: (value: { byBranch: { feature: GhPullRequest }; complete: boolean }) => void
  read.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  )
  await act(async () => root.render(<LanePrStatus sessionId="a" />))
  expect(pill()).toBeNull()
  await act(async () => finish({ byBranch: { feature: pr }, complete: true }))
  expect(pill()?.textContent).toBe('#42')
  read.mockImplementationOnce(() => new Promise(() => {}))
  await act(async () => pill()!.click())
  await act(async () => button('Refresh').click())
  expect(button('Refreshing').getAttribute('aria-busy')).toBe('true')
  expect(pill()?.textContent).toBe('#42')
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
    byBranch: {
      'remote-feature': { ...pr, number: 99, url: 'https://github.com/example/repo/pull/99' },
    },
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
  // A Host lane's PRs are never read by number or for detail from this machine.
  expect(summaries).not.toHaveBeenCalled()
})

it('requests a stale refresh when activating another lane in the same repository', async () => {
  await act(async () => root.render(<LanePrStatus sessionId="a" />))
  usePullRequestsStore.setState((s) => ({
    byRepo: { '/repo': { ...s.byRepo['/repo']!, attemptedAt: Date.now() - 60_001 } },
  }))
  await act(async () => root.render(<LanePrStatus sessionId="b" />))
  expect(read).toHaveBeenCalledTimes(2)
})

it('uses the checkout branch’s coverage for the checkout’s PR not yet read by number, and shows nothing once it is gone', async () => {
  summaries.mockImplementation(() => new Promise(() => {}))
  seed(pr)
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
  expect(document.querySelector('[data-testid="pr-inspector-stale"]')).not.toBeNull()
  expect(detail()?.textContent).toContain(
    'The last read failed 10s ago. Showing status from 2m ago.',
  )
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
  // Confirmed absence shows nothing: no "no PR" face (the lane has no PR control).
  expect(pill()).toBeNull()
})
