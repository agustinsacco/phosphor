// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DEFAULT_LANE_PREFS, type SessionMeta } from '@shared/models'
import { ContextMenuHost } from '@/components/ContextMenu'
import { useChatStore } from '@/stores/chat'
import { useLaneMoveStore } from '@/stores/laneMove'
import { useLanePrefsStore } from '@/stores/lanePrefs'
import { usePullRequestsStore } from '@/stores/pullRequests'
import { useSessionsStore } from '@/stores/sessions'
import { resetSidebarStores, stubSidebarPhosphor } from './__fixtures__/sidebarHarness'
import { Sidebar } from './Sidebar'

/* This Mac's lane menus, full and in order, as they read before one builder served both machines. */

vi.mock('@/lib/monaco', () => ({}))
let root: Root
let container: HTMLDivElement
const invoke = vi.fn()

const meta = (n: number, patch: Partial<SessionMeta> = {}): SessionMeta => ({
  path: `/repo/s${n}.jsonl`,
  sessionId: `s${n}`,
  cwd: '/repo',
  createdAt: '',
  name: `Lane ${n}`,
  userMessages: 1,
  assistantMessages: 1,
  toolCalls: 0,
  totalTokens: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  cost: 0,
  headroomSavedTokens: 0,
  entryCount: 2,
  branchCount: 0,
  mtimeMs: 10 - n,
  lastActivityAt: '',
  ...patch,
})
const UNSEEN_AT = '2026-09-10T12:00:00.000Z'

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  Element.prototype.scrollIntoView = vi.fn()
  stubSidebarPhosphor(invoke)
  invoke.mockReset().mockImplementation(async (channel: string) =>
    channel === 'app:getPrefs'
      ? {
          seenSessions: useSessionsStore.getState().seenSessions,
          pinnedSessions: useSessionsStore.getState().pinned,
        }
      : channel === 'routines:laneIndex'
        ? {}
        : channel === 'git:listWorktrees'
          ? []
          : channel === 'sessions:list'
            ? (useSessionsStore.getState().disk['/repo'] ?? [])
            : null,
  )
  resetSidebarStores()
  useChatStore.setState({ sessions: {} })
  useLaneMoveStore.setState({ draft: null })
  useLanePrefsStore.setState({ lanes: DEFAULT_LANE_PREFS })
  usePullRequestsStore.setState({ byRepo: {} })
  useSessionsStore.setState({
    live: {},
    unread: {},
    pinned: [],
    seenSessions: {},
    laneMarkers: {},
    bulkDelete: null,
    disk: { '/repo': [meta(1)] },
    refreshMissing: vi.fn().mockResolvedValue(undefined),
  })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

/** Each row as `[label + hint, disabled, separator above]`. */
async function menuRows(title: string): Promise<[string, boolean, boolean][]> {
  await act(async () =>
    root.render(
      <>
        <Sidebar workspacePath="/repo" />
        <ContextMenuHost />
      </>,
    ),
  )
  await act(async () => {})
  const row = [...container.querySelectorAll('[data-testid=session-row]')].find((r) =>
    r.textContent?.includes(title),
  )!
  act(() => {
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
  })
  const menu = document.querySelector('[data-testid=context-menu]')!
  return [...menu.querySelectorAll('button')].map((b) => [
    b.textContent ?? '',
    b.disabled,
    b.previousElementSibling !== null,
  ])
}

it("characterizes This Mac's menu for a saved lane", async () => {
  expect(await menuRows('Lane 1')).toEqual([
    ['Open', false, false],
    ['Move upAlt+↑', true, false],
    ['Move downAlt+↓', true, false],
    ['Rename…', false, false],
    ['Session tree…', false, false],
    ['Finish conversation…', false, false],
    ['Make routine…', false, false],
    ['Pin', false, false],
    ['Lane marker…', false, false],
    ['Forknew branch', false, true],
    ['Clone', false, false],
    ['Move to…', false, false],
    ['Export HTML…', false, false],
    ['Copy debug info', false, false],
    ['Deleteto trash', false, true],
  ])
})

it("characterizes This Mac's menu for a live, unseen lane with a PR and spend", async () => {
  usePullRequestsStore.setState({
    byRepo: {
      '/repo': {
        byBranch: {
          'wt-branch': {
            number: 7,
            title: 'PR 7',
            url: 'https://example.test/7',
            state: 'OPEN',
          } as never,
        },
        fetchedAt: Date.now(),
        attemptedAt: Date.now(),
        loading: false,
      },
    },
  })
  useSessionsStore.setState({
    live: { live1: { phosphorId: 'live1', workspacePath: '/repo', diskPath: '/repo/s1.jsonl' } },
    seenSessions: { '/repo/s1.jsonl': Date.parse(UNSEEN_AT) - 60_000 },
    disk: { '/repo': [meta(1, { cwd: '/wt1', cost: 1.5, lastActivityAt: UNSEEN_AT })] },
    gitByCwd: {
      '/wt1': { branch: 'wt-branch', mainRepoPath: '/repo', isWorktree: true } as never,
    },
  })
  expect(await menuRows('Lane 1')).toEqual([
    ['Open', false, false],
    ['Move upAlt+↑', true, false],
    ['Move downAlt+↓', true, false],
    ['Rename…', false, false],
    ['Session tree…', false, false],
    ['Finish conversation…', false, false],
    ['Make routine…', false, false],
    ['Pin', false, false],
    ['Lane marker…', false, false],
    ['Pull requests›', false, false],
    ['Stop~200 MB', false, false],
    ['Mark read', false, false],
    ['Forknew branch', false, true],
    ['Clone', false, false],
    ['Move to…stops it first', false, false],
    ['Export HTML…', false, false],
    ['Copy debug info', false, false],
    ['Copy spend$1.50', false, false],
    ['Deleteto trash', false, true],
  ])
})

it('refuses Move to… only while a live lane is working', async () => {
  useSessionsStore.setState({
    live: { live1: { phosphorId: 'live1', workspacePath: '/repo', diskPath: '/repo/s1.jsonl' } },
  })
  useChatStore.getState().ensure('live1')
  useChatStore.setState((s) => ({
    sessions: { live1: { ...s.sessions.live1!, isStreaming: true } },
  }))
  const rows = await menuRows('Lane 1')
  expect(rows.find(([label]) => label.startsWith('Move to…'))).toEqual([
    'Move to…Wait for this lane to finish working.',
    true,
    false,
  ])
})

it('stops an idle live lane before opening Move to… for it', async () => {
  useSessionsStore.setState({
    live: { live1: { phosphorId: 'live1', workspacePath: '/repo', diskPath: '/repo/s1.jsonl' } },
  })
  await menuRows('Lane 1')
  const item = [...document.querySelectorAll('[data-testid=context-menu] button')].find((b) =>
    b.textContent?.startsWith('Move to…'),
  ) as HTMLButtonElement
  await act(async () => item.click())
  await vi.waitFor(() => expect(useLaneMoveStore.getState().draft).not.toBeNull(), {
    timeout: 5000,
  })
  expect(invoke).toHaveBeenCalledWith('pi:disposeSession', 'live1')
  expect(useLaneMoveStore.getState().draft?.source).toEqual({
    machine: 'local',
    sessionPath: '/repo/s1.jsonl',
  })
})

it("characterizes This Mac's menu for a finished lane whose worktree was removed", async () => {
  useSessionsStore.setState({
    disk: {
      '/repo': [
        meta(1, { completedAt: Date.parse('2026-09-01T00:00:00.000Z'), worktreeRemoved: true }),
      ],
    },
  })
  expect(await menuRows('Lane 1')).toEqual([
    ['Open', false, false],
    ['Move upAlt+↑', true, false],
    ['Move downAlt+↓', true, false],
    ['Rename…', false, false],
    ['Session tree…', false, false],
    ['Reopen conversation', false, false],
    ['Restore worktree…', false, false],
    ['Make routine…', false, false],
    ['Pin', false, false],
    ['Lane marker…', false, false],
    ['Forknew branch', false, true],
    ['Clone', false, false],
    ['Move to…', false, false],
    ['Export HTML…', false, false],
    ['Copy debug info', false, false],
    ['Deleteto trash', false, true],
  ])
})

it("characterizes This Mac's menu with lane markers off, and while a bulk delete runs", async () => {
  useLanePrefsStore.setState({ lanes: { ...DEFAULT_LANE_PREFS, markers: 'off' } })
  useSessionsStore.setState({
    bulkDelete: {
      total: 1,
      done: 0,
      current: 'Lane 9',
      currentPath: '/repo/s9.jsonl',
      lanes: [{ path: '/repo/s9.jsonl', title: 'Lane 9' }],
      results: [],
      running: true,
      cancelled: false,
    },
  })
  expect(await menuRows('Lane 1')).toEqual([
    ['Open', false, false],
    ['Move upAlt+↑', true, false],
    ['Move downAlt+↓', true, false],
    ['Rename…', false, false],
    ['Session tree…', false, false],
    ['Finish conversation…', false, false],
    ['Make routine…', false, false],
    ['Pin', false, false],
    ['Forknew branch', false, true],
    ['Clone', false, false],
    ['Move to…', false, false],
    ['Export HTML…', false, false],
    ['Copy debug info', false, false],
    ['Deleteanother delete is running', true, true],
  ])
})

it("characterizes This Mac's menu for a lane in the Pinned list", async () => {
  useSessionsStore.setState({
    pinned: ['/repo/s1.jsonl'],
    hydratePinned: vi.fn().mockResolvedValue(undefined),
  })
  expect(await menuRows('Lane 1')).toEqual([
    ['Open', false, false],
    ['Move upAlt+↑', true, false],
    ['Move downAlt+↓', true, false],
    ['Rename…', false, false],
    ['Session tree…', false, false],
    ['Finish conversation…', false, false],
    ['Make routine…', false, false],
    ['Unpin', false, false],
    ['Lane marker…', false, false],
    ['Forknew branch', false, true],
    ['Clone', false, false],
    ['Move to…', false, false],
    ['Export HTML…', false, false],
    ['Copy debug info', false, false],
    ['Deleteto trash', false, true],
  ])
})

it("characterizes This Mac's menu for a pending lane, before its file lands", async () => {
  useSessionsStore.setState({
    live: { live9: { phosphorId: 'live9', workspacePath: '/repo' } },
    disk: { '/repo': [] },
  })
  expect(await menuRows('New session')).toEqual([
    ['Open', false, false],
    ['Move upAlt+↑', true, false],
    ['Move downAlt+↓', true, false],
    ['Rename…', false, false],
    ['Export HTML…', false, true],
    ['Delete', false, true],
  ])
})
