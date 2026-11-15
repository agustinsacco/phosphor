// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { GitInfo, SessionMeta } from '@shared/models'
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
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { LanePrStatus } from './LanePrStatus'

// The lane's checkout branch never had a PR. A subagent opened one from a
// branch it created in another worktree, and the session file recorded it.
const git: GitInfo = { isRepo: true, isWorktree: true, mainRepoPath: '/repo', branch: 'scratch' }
const ref = { host: 'github.com', owner: 'GoAugment', repo: 'augment-services', number: 20244 }
const meta = {
  path: '/sessions/a.jsonl',
  sessionId: 'a',
  cwd: '/repo/wt',
  createdAt: '2026-11-09T15:55:34.682Z',
  userMessages: 1,
  assistantMessages: 1,
  toolCalls: 1,
  totalTokens: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  cost: 0,
  headroomSavedTokens: 0,
  entryCount: 3,
  branchCount: 0,
  mtimeMs: 1,
  lastActivityAt: '2026-11-09T20:12:55.000Z',
  pullRequests: {
    opened: [ref],
    branches: ['agustin/skt-5294-knowledge-service-cli'],
    reviewing: [],
    mentioned: [],
    pinned: [],
    hidden: [],
  },
} as SessionMeta
const summary = {
  ref,
  number: 20244,
  title: 'feat(knowledge-service): add a knowledge-service CLI',
  state: 'OPEN',
  url: 'https://github.com/GoAugment/augment-services/pull/20244',
  headRefName: 'agustin/skt-5294-knowledge-service-cli',
  baseRefName: 'main',
  additions: 9697,
  deletions: 207,
  changedFiles: 49,
  updatedAt: '2026-11-12T15:48:50Z',
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'BLOCKED',
  reviewDecision: 'REVIEW_REQUIRED',
  checks: { passed: 27, failed: 0, pending: 0, total: 27 },
  comments: 0,
  checkRuns: null,
  checksTruncated: false,
  approvedBy: ['a', 'b', 'c'],
  changesRequestedBy: [],
  waitingOn: [
    { name: 'knowledge', team: true, codeOwner: true },
    { name: 'eng-managers', team: true, codeOwner: true },
  ],
  threads: { total: 0, unresolved: 0 },
  inMergeQueue: false,
  autoMerge: false,
}
const key = 'github.com/goaugment/augment-services#20244'

let root: Root
let container: HTMLDivElement
let restore: () => void
let dispose: () => void
const summaries = vi.fn(async () => ({
  byKey: { [key]: summary },
  coverage: { [key]: { state: 'found', checkedAt: Date.now(), attemptedAt: Date.now() } },
}))

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.useFakeTimers()
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
  useSessionsStore.setState({
    activeSessionId: 'a',
    live: { a: { phosphorId: 'a', workspacePath: '/repo/wt', diskPath: meta.path } },
    disk: { '/repo/wt': [meta] },
    gitByCwd: { '/repo/wt': git },
  })
  useChatStore.setState({ sessions: {} })
  useLayoutStore.setState({ sidebarVisible: false })
  useLanePrefsStore.getState().applyLanePrefs({ prStatus: true })
  usePullRequestsStore.setState({ byRepo: {}, available: true })
  usePrStatusStore.setState({ byKey: {} })
  useRemoteLanesStore.setState({ hosts: {}, filter: 'local' })
  summaries.mockClear()
  const fake = createFakePhosphor({
    'gh:available': async () => true,
    'gh:prsForRepo': async () => ({ byBranch: {}, complete: true }),
    'git:infoBatch': async () => ({ '/repo/wt': git }),
    'gh:prSummaries': summaries as never,
    'gh:prDetail': async () => null,
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

it('shows the PR a lane opened from a branch other than its checkout', async () => {
  await act(async () => root.render(<LanePrStatus sessionId="a" />))
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10)
  })
  const pill = container.querySelector('[data-testid="lane-pr-status"]')
  expect(pill?.textContent).toContain('#20244')
  expect(pill?.getAttribute('aria-label')).toBe(
    'Pull request #20244: Waiting on code owners @knowledge, @eng-managers.',
  )
})

it('reads a PR’s freshness from its own read, never from the checkout branch it is not on', async () => {
  // Regression: the popover said "No successful upstream check yet" for a PR
  // read by number seconds ago, because it looked up the checkout's coverage.
  usePullRequestsStore.setState({
    byRepo: {
      '/repo': {
        byBranch: {},
        coverage: { scratch: { state: 'absent', checkedAt: 0, attemptedAt: Date.now() } },
        fetchedAt: Date.now(),
        attemptedAt: Date.now(),
        loading: false,
      },
    },
  })
  await act(async () => root.render(<LanePrStatus sessionId="a" />))
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10)
  })
  const pill = container.querySelector<HTMLButtonElement>('[data-testid="lane-pr-status"]')!
  await act(async () => pill.click())
  const details = document.querySelector('[aria-label="Pull request details"]')!
  expect(details.textContent).toContain('checked 0s ago')
  expect(details.textContent).not.toContain('not checked yet')
  expect(details.querySelector('[data-testid="pr-inspector-stale"]')).toBeNull()
})
