// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { SessionMeta } from '@shared/models'
import { ContextMenuHost } from '@/components/ContextMenu'
import { useChatStore } from '@/stores/chat'
import { useMachinesStore } from '@/stores/machines'
import { usePullRequestsStore } from '@/stores/pullRequests'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { useSessionsStore } from '@/stores/sessions'
import { useWorkspacesStore } from '@/stores/workspaces'
import { Sidebar } from './Sidebar'

vi.mock('@/lib/monaco', () => ({ languageForPath: () => 'plaintext' }))
let root: Root
let container: HTMLDivElement
const invoke = vi.fn()

const meta = (n: number, lastActivityAt = ''): SessionMeta => ({
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
  lastActivityAt,
})
const UNSEEN_AT = '2026-09-10T12:00:00.000Z'
// Lane 2 was last seen before its latest activity: it is unseen.
const SEEN = { '/repo/s2.jsonl': Date.parse(UNSEEN_AT) - 60_000 }

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  Element.prototype.scrollIntoView = vi.fn()
  Object.defineProperty(window, 'phosphor', {
    configurable: true,
    value: {
      invoke,
      onUpdateEvent: () => () => {},
      onAccountChanged: () => () => {},
      onRoutinesChanged: () => () => {},
      onSessionsChanged: () => () => {},
    },
  })
  invoke
    .mockReset()
    .mockImplementation(async (channel: string) =>
      channel === 'app:getPrefs'
        ? { seenSessions: SEEN }
        : channel === 'routines:laneIndex'
          ? {}
          : channel === 'git:listWorktrees'
            ? []
            : channel === 'sessions:list'
              ? (useSessionsStore.getState().disk['/repo'] ?? [])
              : null,
    )
  useMachinesStore.setState({ remoteEnabled: false, machines: [], adding: false })
  useRemoteLanesStore.setState({ hosts: {}, filter: 'local', error: null })
  useWorkspacesStore.setState({
    recents: [{ path: '/repo', name: 'repo', lastOpenedAt: 0 }],
    hydrated: true,
  })
  useSessionsStore.setState({
    live: { live1: { phosphorId: 'live1', workspacePath: '/repo', diskPath: '/repo/s1.jsonl' } },
    unread: {},
    pinned: [],
    seenSessions: SEEN,
    bulkDelete: null,
    disk: { '/repo': [meta(1), meta(2, UNSEEN_AT)] },
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

async function menuFor(title: string): Promise<string[]> {
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
  return [...document.querySelectorAll('[data-testid=context-menu] button')].map(
    (b) => b.textContent ?? '',
  )
}

it("calls stopping a live This Mac lane Stop, as a Host lane's menu does", async () => {
  const rows = await menuFor('Lane 1')
  expect(rows.some((label) => label.startsWith('Stop'))).toBe(true)
  expect(rows.some((label) => label.startsWith('Suspend'))).toBe(false)
  expect(rows).not.toContain('Mark read')
})

it('offers Mark read on an unseen This Mac lane, and it marks the lane seen', async () => {
  const rows = await menuFor('Lane 2')
  expect(rows).toContain('Mark read')
  const markRead = [
    ...document.querySelectorAll<HTMLButtonElement>('[data-testid=context-menu] button'),
  ].find((b) => b.textContent === 'Mark read')!
  act(() => markRead.click())
  expect(useSessionsStore.getState().seenSessions['/repo/s2.jsonl']).toBeGreaterThan(
    Date.parse(UNSEEN_AT),
  )
  expect(invoke).toHaveBeenCalledWith('app:markSessionSeen', '/repo/s2.jsonl')
})

it('selects merged lanes from a This Mac group menu, through the same rows as a Host folder', async () => {
  const pr = (number: number, state: 'MERGED' | 'OPEN') =>
    ({ number, title: `PR ${number}`, url: `https://example.test/${number}`, state }) as never
  usePullRequestsStore.setState({
    byRepo: {
      '/repo': {
        byBranch: { 'merged-branch': pr(1, 'MERGED'), 'open-branch': pr(2, 'OPEN') },
        fetchedAt: Date.now(),
        attemptedAt: Date.now(),
        loading: false,
      },
    },
  })
  useSessionsStore.setState({
    live: {},
    disk: { '/repo': [meta(1), { ...meta(2), cwd: '/wt2' }] },
    gitByCwd: {
      '/repo': { branch: 'merged-branch', mainRepoPath: '/repo' } as never,
      '/wt2': { branch: 'open-branch', mainRepoPath: '/repo', isWorktree: true } as never,
    },
  })
  await act(async () =>
    root.render(
      <>
        <Sidebar workspacePath="/repo" />
        <ContextMenuHost />
      </>,
    ),
  )
  await act(async () => {})
  act(() => container.querySelector<HTMLElement>('[data-testid=workspace-group-menu]')!.click())
  const rows = [...document.querySelectorAll<HTMLButtonElement>('[data-popup-menu] button')]
  expect(rows.map((b) => b.textContent)).toEqual(
    expect.arrayContaining(['Select all lanes', 'Select merged lanes', 'Collapse lanes']),
  )
  act(() => rows.find((b) => b.textContent === 'Select merged lanes')!.click())
  const checked = [...container.querySelectorAll('[role=checkbox][aria-checked=true]')].map((b) =>
    b.getAttribute('aria-label'),
  )
  expect(checked).toEqual(['Select Lane 1'])
})

it('finds a This Mac lane by its live session name, ahead of the disk scan', async () => {
  useChatStore.setState({
    sessions: { live1: { meta: { sessionName: 'Renamed just now' } } } as never,
  })
  await act(async () => root.render(<Sidebar workspacePath="/repo" />))
  await act(async () => {})
  act(() => container.querySelector<HTMLButtonElement>('[aria-label^="Search lanes in"]')!.click())
  const input = container.querySelector<HTMLInputElement>('[data-testid=lane-search-input]')!
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
      input,
      'renamed',
    )
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  act(() => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })
  const rows = [...container.querySelectorAll('[data-testid=session-row]')].map(
    (r) => r.textContent,
  )
  expect(rows).toHaveLength(1)
  expect(rows[0]).toContain('Renamed just now')
})

it("shows a lane's PR chip from its main repository's listing, and none for a lane without one", async () => {
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
    live: {},
    disk: { '/repo': [meta(1), { ...meta(2), cwd: '/wt2' }] },
    gitByCwd: {
      '/repo': { branch: 'main', mainRepoPath: '/repo' } as never,
      '/wt2': { branch: 'wt-branch', mainRepoPath: '/repo', isWorktree: true } as never,
    },
  })
  await act(async () => root.render(<Sidebar workspacePath="/repo" />))
  await act(async () => {})
  const chips = [...container.querySelectorAll('[data-testid=session-row]')].map((row) => [
    row.textContent?.includes('Lane 1') ? 'Lane 1' : 'Lane 2',
    row.querySelector('[data-testid=session-pr-badge]')?.textContent ?? null,
  ])
  expect(chips).toEqual([
    ['Lane 1', null],
    ['Lane 2', expect.stringContaining('#7')],
  ])
})
