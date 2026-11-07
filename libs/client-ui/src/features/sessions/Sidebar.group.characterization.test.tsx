// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { SessionMeta } from '@shared/models'
import { ContextMenuHost } from '@/components/ContextMenu'
import { useSessionsStore } from '@/stores/sessions'
import { useWorkspacesStore } from '@/stores/workspaces'
import { setGroupCollapsed, useGroupCollapse } from './groupCollapse'
import { resetSidebarStores, stubSidebarPhosphor } from './__fixtures__/sidebarHarness'
import { Sidebar } from './Sidebar'

/* This Mac's workspace group, as it reads before one group component served both machines. */

vi.mock('@/lib/monaco', () => ({}))
let root: Root
let container: HTMLDivElement
const invoke = vi.fn()
const refreshDisk = vi.fn()
const removeWorkspace = vi.fn()
const deleteSandbox = vi.fn()

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

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  Element.prototype.scrollIntoView = vi.fn()
  stubSidebarPhosphor(invoke)
  invoke
    .mockReset()
    .mockImplementation(async (channel: string) =>
      channel === 'app:getPrefs' || channel === 'routines:laneIndex'
        ? {}
        : channel === 'git:listWorktrees'
          ? []
          : null,
    )
  refreshDisk.mockReset().mockResolvedValue(undefined)
  removeWorkspace.mockReset().mockResolvedValue(true)
  deleteSandbox.mockReset().mockResolvedValue({ ok: true })
  resetSidebarStores()
  useGroupCollapse.setState({ collapsed: null })
  useWorkspacesStore.setState({ sandboxes: [], removeWorkspace, deleteSandbox })
  useSessionsStore.setState({
    live: {},
    unread: {},
    pinned: [],
    seenSessions: {},
    bulkDelete: null,
    gitByCwd: {},
    disk: { '/repo': [meta(1)] },
    scanStatus: { '/repo': 'ok' },
    refreshDisk,
    refreshAllDisk: vi.fn().mockResolvedValue(undefined),
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

async function renderSidebar(workspacePath = '/repo'): Promise<void> {
  await act(async () =>
    root.render(
      <>
        <Sidebar workspacePath={workspacePath} />
        <ContextMenuHost />
      </>,
    ),
  )
  await act(async () => {})
}
const optionsRows = (): HTMLButtonElement[] => [
  ...document.querySelectorAll<HTMLButtonElement>('[data-popup-menu] button'),
]
function openOptions(): [string, boolean][] {
  act(() => container.querySelector<HTMLElement>('[data-testid=workspace-group-menu]')!.click())
  return optionsRows().map((b) => [b.textContent ?? '', b.disabled])
}
const optionsRow = (label: string): HTMLButtonElement =>
  optionsRows().find((b) => b.textContent === label)!
const laneTitles = (): string[] =>
  [...container.querySelectorAll('[data-testid=session-title]')].map((t) => t.textContent ?? '')

it("characterizes a This Mac group's ⋯ rows, and Remove confirming in place", async () => {
  await renderSidebar()
  expect(openOptions()).toEqual([
    ['Select all lanes', false],
    ['Select merged lanes', false],
    ['Collapse lanes', false],
    ['Move up', true],
    ['Move down', true],
    ['Remove from sidebar', false],
  ])
  act(() => optionsRow('Remove from sidebar').click())
  expect(removeWorkspace).not.toHaveBeenCalled()
  act(() => optionsRow('Remove? Files stay on disk').click())
  expect(removeWorkspace).toHaveBeenCalledWith(['/repo'])
})

it("characterizes a sandbox group's ⋯ rows, and Delete confirming in place", async () => {
  useWorkspacesStore.setState({
    sandboxes: [{ path: '/repo', name: 'repo', itemCount: 0, lastUsedAt: 0 }],
  })
  await renderSidebar()
  expect(openOptions()).toEqual([
    ['Select all lanes', false],
    ['Select merged lanes', false],
    ['Collapse lanes', false],
    ['Move up', true],
    ['Move down', true],
    ['Rename sandbox…', false],
    ['Delete sandbox…', false],
  ])
  act(() => optionsRow('Delete sandbox…').click())
  expect(deleteSandbox).not.toHaveBeenCalled()
  act(() => optionsRow('Delete, with its chats?').click())
  expect(deleteSandbox).toHaveBeenCalledWith('/repo')
})

function headerMenu(): [string, boolean][] {
  act(() => {
    container
      .querySelector('[data-testid=workspace-group]')!
      .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
  })
  const menu = document.querySelector('[data-testid=context-menu]')!
  return [...menu.querySelectorAll('button')].map((b) => [
    b.textContent ?? '',
    b.previousElementSibling !== null,
  ])
}

it("characterizes a This Mac group header's right-click menu: New session only", async () => {
  await renderSidebar()
  expect(headerMenu()).toEqual([['New session', false]])
})

it('characterizes a worktree group header: New session, then Merge and Remove worktree', async () => {
  useWorkspacesStore.setState({ recents: [{ path: '/wt', name: 'wt', lastOpenedAt: 0 }] })
  useSessionsStore.setState({
    disk: { '/wt': [meta(1, { path: '/wt/s1.jsonl', cwd: '/wt' })] },
    scanStatus: { '/wt': 'ok' },
    gitByCwd: { '/wt': { branch: 'wt', mainRepoPath: '/main', isWorktree: true } as never },
  })
  await renderSidebar('/wt')
  expect(headerMenu()).toEqual([
    ['New session', false],
    ['Merge into main…', true],
    ['Remove worktree…', false],
  ])
})

it('characterizes a failed group: "Couldn\'t load sessions" and a Retry that rescans it', async () => {
  useSessionsStore.setState({ disk: {}, scanStatus: { '/repo': 'error' } })
  await renderSidebar()
  expect(container.textContent).toContain("Couldn't load sessions")
  const retry = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Retry')!
  act(() => retry.click())
  expect(refreshDisk).toHaveBeenCalledWith('/repo')
})

it('characterizes an empty group: "Sessions you start will show up here"', async () => {
  useSessionsStore.setState({ disk: { '/repo': [] } })
  await renderSidebar()
  expect(container.textContent).toContain('Sessions you start will show up here')
  expect(container.querySelector('[data-testid=sessions-loading]')).toBeNull()
})

it('characterizes a group not yet scanned: row skeletons, no empty copy', async () => {
  useSessionsStore.setState({ disk: {}, scanStatus: {} })
  await renderSidebar()
  expect(container.querySelector('[data-testid=workspace-group]')).not.toBeNull()
  expect(container.querySelector('[data-testid=sessions-loading]')).not.toBeNull()
  expect(container.textContent).not.toContain('Sessions you start will show up here')
})

it('characterizes a partly scanned group: its rows stay, with "loading 1 more folder…"', async () => {
  useWorkspacesStore.setState({
    recents: [
      { path: '/repo', name: 'repo', lastOpenedAt: 0 },
      { path: '/wt', name: 'wt', lastOpenedAt: 0 },
    ],
  })
  useSessionsStore.setState({
    gitByCwd: {
      '/repo': { branch: 'main', mainRepoPath: '/repo' } as never,
      '/wt': { branch: 'wt', mainRepoPath: '/repo', isWorktree: true } as never,
    },
  })
  await renderSidebar()
  expect(laneTitles()).toEqual(['Lane 1'])
  expect(container.textContent).toContain('loading 1 more folder…')
})

it('characterizes search on a collapsed group: it opens the group and rescans it', async () => {
  await renderSidebar()
  await act(async () => setGroupCollapsed('/repo', true))
  expect(laneTitles()).toEqual([])
  act(() => container.querySelector<HTMLElement>('[data-testid=workspace-group-search]')!.click())
  expect(laneTitles()).toEqual(['Lane 1'])
  expect(container.querySelector('[data-testid=lane-search-input]')).not.toBeNull()
  expect(refreshDisk).toHaveBeenCalledWith('/repo')
})

async function deleteFromMenu(title: string): Promise<string | undefined> {
  await renderSidebar()
  const row = [...container.querySelectorAll('[data-testid=session-row]')].find((r) =>
    r.textContent?.includes(title),
  )!
  act(() => {
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
  })
  act(() =>
    [...document.querySelectorAll<HTMLButtonElement>('[data-testid=context-menu] button')]
      .find((b) => b.textContent?.startsWith('Delete'))!
      .click(),
  )
  return document.querySelector('h2')?.textContent ?? undefined
}

it("characterizes a row's Delete in the main checkout: the transcript confirm", async () => {
  useSessionsStore.setState({
    gitByCwd: { '/repo': { branch: 'main', mainRepoPath: '/repo' } as never },
  })
  expect(await deleteFromMenu('Lane 1')).toBe('Delete session?')
})

it("characterizes a row's Delete alone in its own worktree: the lane confirm", async () => {
  useSessionsStore.setState({
    disk: { '/repo': [meta(1), meta(2, { cwd: '/wt2' })] },
    gitByCwd: {
      '/repo': { branch: 'main', mainRepoPath: '/repo' } as never,
      '/wt2': { branch: 'wt2', mainRepoPath: '/repo', isWorktree: true } as never,
    },
  })
  expect(await deleteFromMenu('Lane 2')).toBe('Delete lane')
})
