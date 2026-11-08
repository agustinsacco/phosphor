// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { SessionMeta } from '@shared/models'
import { useSessionsStore } from '@/stores/sessions'
import { useWorkspacesStore } from '@/stores/workspaces'
import { setGroupCollapsed } from './groupCollapse'
import { localLaneGroupKey, requestReveal } from './laneReveal'
import { resetSidebarStores, stubSidebarPhosphor } from './__fixtures__/sidebarHarness'
import { Sidebar } from './Sidebar'

vi.mock('@/lib/monaco', () => ({}))
let root: Root
let container: HTMLDivElement
const invoke = vi.fn()

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  Element.prototype.scrollIntoView = vi.fn()
  stubSidebarPhosphor(invoke)
  invoke
    .mockReset()
    .mockImplementation(async (channel: string) =>
      channel === 'app:getPrefs'
        ? {}
        : channel === 'routines:laneIndex'
          ? {}
          : channel === 'git:listWorktrees' || channel === 'sessions:list'
            ? []
            : null,
    )
  resetSidebarStores()
  useSessionsStore.setState({
    live: {},
    disk: { '/repo': [] },
    refreshAllDisk: vi.fn().mockResolvedValue(undefined),
    refreshMissing: vi.fn().mockResolvedValue(undefined),
    hydratePinned: vi.fn().mockResolvedValue(undefined),
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

it("does not re-scan This Mac's workspaces when a Host folder collapses", async () => {
  await act(async () => root.render(<Sidebar workspacePath="/repo" />))
  await act(async () => {})
  const scans = useSessionsStore.getState().refreshAllDisk as ReturnType<typeof vi.fn>
  const settled = scans.mock.calls.length
  expect(settled).toBeGreaterThan(0)
  await act(async () => setGroupCollapsed('host:h1/repo:r1', true))
  await act(async () => setGroupCollapsed('host:h1/repo:r1', false))
  expect(scans).toHaveBeenCalledTimes(settled)
})

const lane = (cwd: string, n: number): SessionMeta =>
  ({
    path: `${cwd}/s${n}.jsonl`,
    sessionId: `s${n}`,
    cwd,
    createdAt: '',
    name: `Lane ${n}`,
    firstUserText: '',
    mtimeMs: 10 - n,
    lastActivityAt: '',
    branchCount: 0,
    cost: 0,
  }) as SessionMeta
const titles = (): string[] =>
  [...container.querySelectorAll('[data-testid=session-title]')].map((t) => t.textContent ?? '')
const lastCall = (fn: unknown): unknown => (fn as ReturnType<typeof vi.fn>).mock.lastCall?.[0]

it('starts an unscanned group closed and unwatched, and expanding it scans its folders', async () => {
  const refreshDisk = vi.fn().mockResolvedValue(undefined)
  const watchWorkspaces = vi.fn()
  const unwatchWorkspaces = vi.fn()
  useWorkspacesStore.setState({
    recents: [
      { path: '/repo', name: 'repo', lastOpenedAt: 0 },
      { path: '/other', name: 'other', lastOpenedAt: 0 },
    ],
  })
  useSessionsStore.setState({
    disk: { '/repo': [lane('/repo', 1)] },
    scanStatus: { '/repo': 'ok' },
    refreshDisk,
    watchWorkspaces,
    unwatchWorkspaces,
  })
  await act(async () => root.render(<Sidebar workspacePath="/repo" />))
  await act(async () => {})
  expect(titles()).toEqual(['Lane 1'])
  expect(container.querySelector('[data-testid=sessions-loading]')).toBeNull()
  expect(lastCall(watchWorkspaces)).toEqual(['/repo'])
  expect(lastCall(unwatchWorkspaces)).toEqual(['/other'])
  const other = [...container.querySelectorAll<HTMLElement>('[data-testid=workspace-group]')].find(
    (title) => title.textContent?.includes('other'),
  )!
  await act(async () => other.click())
  expect(refreshDisk).toHaveBeenCalledWith('/other')
  expect(container.querySelector('[data-testid=sessions-loading]')).not.toBeNull()
  expect(lastCall(watchWorkspaces)).toEqual(['/repo', '/other'])
})

it('reveals a collapsed, filtered This Mac group: it opens, rescans and drops its search', async () => {
  const refreshDisk = vi.fn().mockResolvedValue(undefined)
  useSessionsStore.setState({
    disk: { '/repo': [lane('/repo', 1)] },
    scanStatus: { '/repo': 'ok' },
    refreshDisk,
  })
  await act(async () => root.render(<Sidebar workspacePath="/repo" />))
  await act(async () => {})
  act(() => container.querySelector<HTMLElement>('[aria-label^="Search lanes in"]')!.click())
  const input = container.querySelector<HTMLInputElement>('[data-testid=lane-search-input]')!
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'zzz')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  act(() => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })
  expect(titles()).toEqual([])
  await act(async () => setGroupCollapsed('/repo', true))
  refreshDisk.mockClear()
  await act(async () => requestReveal(localLaneGroupKey('/repo')))
  expect(titles()).toEqual(['Lane 1'])
  expect(container.querySelector('[data-testid=lane-search-input]')).toBeNull()
  expect(refreshDisk).toHaveBeenCalledWith('/repo')
})
