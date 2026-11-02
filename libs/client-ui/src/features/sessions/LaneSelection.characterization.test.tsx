// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionMeta } from '@shared/models'
import { Sidebar } from './Sidebar'
import { RemoteLanes } from './RemoteLanes'
import { mockRemoteHosts, MOCK_HOST_ID } from '@/dev/mockRemoteLanes'
import { useMachinesStore } from '@/stores/machines'
import { usePullRequestsStore } from '@/stores/pullRequests'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { useSessionsStore } from '@/stores/sessions'
import { useWorkspacesStore } from '@/stores/workspaces'
import { remotePrKey } from '@shared/host-protocol-github'

vi.mock('@/lib/monaco', () => ({ languageForPath: () => 'plaintext' }))
let root: Root
let container: HTMLDivElement
const invoke = vi.fn()

const meta = (n: number): SessionMeta => ({
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
})

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
      channel === 'app:getPrefs' || channel === 'routines:laneIndex'
        ? {}
        : channel === 'git:listWorktrees'
          ? []
          : channel === 'hosts:deleteLane'
            ? { branchKept: false }
            : channel === 'sessions:list'
              ? [meta(1), meta(2), meta(3)]
              : null,
    )
  localStorage.clear()
  useMachinesStore.setState({ remoteEnabled: true, machines: [], adding: false })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

const boxes = () => [...container.querySelectorAll<HTMLElement>('[role=checkbox]')]
const box = (title: string) => {
  const found = boxes().find((b) => b.getAttribute('aria-label') === `Select ${title}`)
  if (!found) throw new Error(`Missing checkbox for ${title}`)
  return found
}
const checked = () =>
  boxes()
    .filter((b) => b.getAttribute('aria-checked') === 'true')
    .map((b) => b.getAttribute('aria-label'))
const click = (el: HTMLElement, shiftKey = false): void =>
  act(() => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey }))
  })
const button = (text: string) => {
  const found = [...document.body.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => b.textContent?.trim() === text,
  )
  if (!found) throw new Error(`Missing button ${text}`)
  return found
}

describe('This Mac', () => {
  beforeEach(() => {
    useWorkspacesStore.setState({
      recents: [{ path: '/repo', name: 'repo', lastOpenedAt: 0 }],
      hydrated: true,
    })
    useSessionsStore.setState({
      live: {},
      unread: {},
      pinned: [],
      seenSessions: {},
      bulkDelete: null,
      disk: { '/repo': [meta(1), meta(2), meta(3)] },
      refreshMissing: vi.fn().mockResolvedValue(undefined),
    })
    useRemoteLanesStore.setState({ hosts: {}, filter: 'local', error: null })
  })
  const render = async () => {
    await act(async () => root.render(<Sidebar workspacePath="/repo" />))
    await act(async () => {})
  }
  const bar = () => container.querySelector('[data-testid=bulk-bar]')

  it('hides each row checkbox until hover or a selection, then counts the selection in the bar', async () => {
    await render()
    expect(boxes().map((b) => b.getAttribute('aria-label'))).toEqual([
      'Select Lane 1',
      'Select Lane 2',
      'Select Lane 3',
    ])
    expect(boxes().every((b) => b.className.includes('hidden group-hover:grid'))).toBe(true)
    expect(bar()).toBeNull()
    click(box('Lane 2'))
    expect(checked()).toEqual(['Select Lane 2'])
    expect(boxes().some((b) => b.className.includes('hidden'))).toBe(false)
    expect(bar()?.textContent).toContain('1 selected')
  })

  it('extends a range with shift, toggles single rows and clears on Escape', async () => {
    await render()
    click(box('Lane 1'))
    click(box('Lane 3'), true)
    expect(checked()).toEqual(['Select Lane 1', 'Select Lane 2', 'Select Lane 3'])
    click(box('Lane 2'))
    expect(checked()).toEqual(['Select Lane 1', 'Select Lane 3'])
    expect(bar()?.textContent).toContain('2 selected')
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    expect(checked()).toEqual([])
    expect(bar()).toBeNull()
  })

  it('selects the whole group from the workspace menu, which then offers Clear selection', async () => {
    await render()
    click(container.querySelector<HTMLElement>('[data-testid=workspace-group-menu]')!)
    click(document.querySelector<HTMLElement>('[data-testid=workspace-group-select]')!)
    expect(checked()).toHaveLength(3)
    click(container.querySelector<HTMLElement>('[data-testid=workspace-group-menu]')!)
    const select = document.querySelector<HTMLElement>('[data-testid=workspace-group-select]')!
    expect(select.textContent).toContain('Clear selection')
    click(select)
    expect(checked()).toEqual([])
  })

  it('opens the shared bulk confirm from the bar and Cancel ends select mode', async () => {
    await render()
    click(box('Lane 1'))
    click(box('Lane 2'))
    click(button('Delete…'))
    const modal = document.querySelector('[data-modal-overlay]')
    expect(modal?.textContent).toContain('Lane 1')
    expect(modal?.textContent).toContain('Lane 2')
    click(button('Cancel'))
    click(button('Cancel'))
    expect(bar()).toBeNull()
    expect(checked()).toEqual([])
  })
})

describe('Host', () => {
  const laneIds = ['00000000-0000-4000-8000-000000000097', '00000000-0000-4000-8000-000000000096']
  beforeEach(() => {
    const host = structuredClone(mockRemoteHosts)[MOCK_HOST_ID]!
    host.capabilities.push('workspaces.write')
    const first = host.lanes[0]!
    first.control.controller = { self: true, label: 'You', connected: true }
    host.lanes = [
      first,
      { ...first, laneId: laneIds[0]!, title: 'Merged lane', branch: 'merged-branch' },
      { ...first, laneId: laneIds[1]!, title: 'Open lane', branch: 'open-branch' },
    ]
    useRemoteLanesStore.setState({ hosts: { [MOCK_HOST_ID]: host }, filter: 'all', error: null })
    useSessionsStore.setState({ live: {}, bulkDelete: null })
    const pr = (state: 'MERGED' | 'OPEN', number: number) => ({
      number,
      title: `PR ${number}`,
      url: `https://example.test/${number}`,
      state,
    })
    usePullRequestsStore.setState({
      byRepo: {
        [remotePrKey(MOCK_HOST_ID, first.repositoryId)]: {
          byBranch: { 'merged-branch': pr('MERGED', 1), 'open-branch': pr('OPEN', 2) },
          fetchedAt: Date.now(),
          attemptedAt: Date.now(),
          complete: true,
          loading: false,
        },
      },
    })
  })

  it('selects merged lanes from the workspace menu and deletes them through Host commands only', async () => {
    await act(async () => root.render(<RemoteLanes />))
    click(container.querySelector<HTMLElement>('[aria-label^="Workspace options"]')!)
    click(button('Select merged lanes'))
    expect(checked()).toEqual(['Select Merged lane'])
    click(button('Delete…'))
    await act(async () => click(button('Delete lane')))
    const deletes = invoke.mock.calls.filter(([channel]) => channel === 'hosts:deleteLane')
    expect(deletes.map(([, host, lane]) => [host, lane])).toEqual([[MOCK_HOST_ID, laneIds[0]]])
    expect(
      invoke.mock.calls.filter(
        ([c]) => String(c).startsWith('sessions:') || String(c).startsWith('git:'),
      ),
    ).toHaveLength(0)
  })
})
