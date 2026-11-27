// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_LANE_PREFS, type SessionMeta } from '@shared/models'
import { mockRemoteHosts, mockRemoteInfo, MOCK_HOST_ID } from '@/dev/mockRemoteLanes'
import { useChatStore } from '@/stores/chat'
import { useLanePrefsStore } from '@/stores/lanePrefs'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { useSessionsStore } from '@/stores/sessions'
import { resetSidebarStores, stubSidebarPhosphor } from './__fixtures__/sidebarHarness'
import { SessionRow } from './LocalLaneRow'
import { PendingSessionRow } from './LocalPendingLaneRow'
import { RemoteLaneRow } from './RemoteLaneRow'
import { renameSidebarSession } from './sidebarActions'
import { applySessionRename } from './sessionActions'
import type * as SidebarActionsModule from './sidebarActions'
import type * as SessionActionsModule from './sessionActions'

type SidebarActions = typeof SidebarActionsModule
type SessionActions = typeof SessionActionsModule

/* The three lane rows' DOM, exactly, before they share one presentation. */

// The snapshots carry local times: pin the zone so CI (UTC) and laptops agree.
const previousTz = process.env.TZ
beforeAll(() => {
  process.env.TZ = 'America/New_York'
})
afterAll(() => {
  if (previousTz === undefined) delete process.env.TZ
  else process.env.TZ = previousTz
})

vi.mock('@/lib/monaco', () => ({}))
vi.mock('./sidebarActions', async (original) => ({
  ...(await original<SidebarActions>()),
  renameSidebarSession: vi.fn(async () => {}),
}))
vi.mock('./sessionActions', async (original) => ({
  ...(await original<SessionActions>()),
  applySessionRename: vi.fn(async () => true),
}))

let root: Root
let container: HTMLDivElement
const invoke = vi.fn(async () => null)

const meta: SessionMeta = {
  path: '/repo/s1.jsonl',
  sessionId: 's1',
  cwd: '/repo',
  createdAt: '',
  name: 'Saved lane',
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
  branchCount: 2,
  mtimeMs: 0,
  lastActivityAt: '',
}
const git = { isRepo: true, branch: 'feature/x', isWorktree: true } as never

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.useFakeTimers({ now: new Date('2026-09-10T12:00:00.000Z'), toFake: ['Date'] })
  stubSidebarPhosphor(invoke)
  resetSidebarStores()
  useLanePrefsStore.setState({ lanes: { ...DEFAULT_LANE_PREFS, markers: 'auto' } })
  useChatStore.setState({ sessions: {} })
  useSessionsStore.setState({
    live: {
      p1: { phosphorId: 'p1', workspacePath: '/repo' } as never,
      live1: { phosphorId: 'live1', workspacePath: '/repo', diskPath: meta.path } as never,
    },
    suspendedPaths: [],
    deletingSessionKeys: [],
    laneMarkers: {},
    bulkDelete: null,
  })
  useChatStore.getState().ensure('p1')
  useChatStore.getState().ensure('live1')
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function render(element: React.JSX.Element): string {
  act(() => root.render(element))
  return container.innerHTML
}
const saved = (patch: Partial<React.ComponentProps<typeof SessionRow>> = {}) => (
  <SessionRow
    meta={meta}
    workspacePath="/repo"
    active={false}
    unseen={false}
    git={git}
    isPinned={false}
    onOpenTree={() => {}}
    onDelete={() => {}}
    {...patch}
  />
)
const row = () =>
  container.querySelector<HTMLElement>(
    '[data-testid=session-row], [data-testid=remote-session-row]',
  )!
const typeName = (value: string) =>
  act(() => {
    const input = container.querySelector('input')!
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
const key = (k: string) =>
  act(() => {
    container
      .querySelector('input')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }))
  })
const dblclick = () => act(() => row().dispatchEvent(new MouseEvent('dblclick', { bubbles: true })))

describe('This Mac saved row', () => {
  it('renders a stored lane', () => {
    expect(render(saved())).toMatchSnapshot()
  })

  it('renders a live, unseen, active, pinned lane with its folder badge', () => {
    expect(
      render(
        saved({
          livePhosphorId: 'live1',
          unseen: true,
          active: true,
          isPinned: true,
          showWorkspace: true,
        }),
      ),
    ).toMatchSnapshot()
  })

  it('renders a suspended lane, and one being deleted', () => {
    useSessionsStore.setState({ suspendedPaths: [meta.path] })
    expect(render(saved())).toMatchSnapshot()
    act(() => useSessionsStore.setState({ suspendedPaths: [], deletingSessionKeys: [meta.path] }))
    expect(container.innerHTML).toMatchSnapshot()
  })

  it('renames inline on double-click: a div while editing, Enter saves, Escape cancels', () => {
    render(saved({ livePhosphorId: 'live1' }))
    dblclick()
    expect(container.innerHTML).toMatchSnapshot()
    expect(row().tagName).toBe('DIV')
    typeName('  New name ')
    key('Enter')
    expect(renameSidebarSession).toHaveBeenCalledWith('/repo', meta, 'New name', 'live1')
    expect(row().tagName).toBe('BUTTON')
    dblclick()
    typeName('Other')
    key('Escape')
    expect(renameSidebarSession).toHaveBeenCalledTimes(1)
    expect(row().tagName).toBe('BUTTON')
  })
})

describe('This Mac pending row', () => {
  it('renders a lane whose file has not landed, then while deleting', () => {
    expect(
      render(<PendingSessionRow phosphorId="p1" active git={git} onDelete={() => {}} />),
    ).toMatchSnapshot()
    act(() => useSessionsStore.setState({ deletingSessionKeys: ['p1'] }))
    expect(container.innerHTML).toMatchSnapshot()
  })

  it('renames inline on double-click without a rescan', () => {
    render(<PendingSessionRow phosphorId="p1" active={false} git={git} onDelete={() => {}} />)
    dblclick()
    expect(container.innerHTML).toMatchSnapshot()
    typeName('Fresh')
    key('Enter')
    expect(applySessionRename).toHaveBeenCalledWith('p1', 'Fresh')
    expect(row().tagName).toBe('BUTTON')
  })

  it('hands off to the saved row with the same title, marker and subtitle', () => {
    useChatStore.setState((s) => ({
      sessions: {
        ...s.sessions,
        live1: { ...s.sessions.live1!, meta: { sessionName: 'Handed off' } as never },
      },
    }))
    render(<PendingSessionRow phosphorId="live1" active={false} git={git} onDelete={() => {}} />)
    const before = {
      title: container.querySelector('[data-testid=session-title]')!.outerHTML,
      marker: row().children[1]!.outerHTML,
    }
    render(saved({ livePhosphorId: 'live1' }))
    expect(container.querySelector('[data-testid=session-title]')!.outerHTML).toBe(before.title)
    expect(row().children[1]!.textContent).toBe(before.marker.replace(/<[^>]+>/g, ''))
  })
})

describe('Host lane row', () => {
  beforeEach(() => {
    const hosts = structuredClone(mockRemoteHosts)
    hosts[MOCK_HOST_ID]!.capabilities.push('workspaces.write')
    hosts[MOCK_HOST_ID]!.lanes[0]!.control.controller = {
      self: true,
      label: 'You',
      connected: true,
    }
    useRemoteLanesStore.setState({ hosts })
    useSessionsStore.setState({
      live: {
        [mockRemoteInfo.sessionId]: { ...mockRemoteInfo, phosphorId: mockRemoteInfo.sessionId },
      },
    })
    useChatStore.getState().ensure(mockRemoteInfo.sessionId)
  })
  const remote = (ready: boolean) => (
    <RemoteLaneRow
      hostId={MOCK_HOST_ID}
      lane={useRemoteLanesStore.getState().hosts[MOCK_HOST_ID]!.lanes[0]!}
      ready={ready}
      active
      workspaceName="repo"
    />
  )

  it('renders ready, not ready and editing', () => {
    expect(render(remote(true))).toMatchSnapshot()
    expect(render(remote(false))).toMatchSnapshot()
    render(remote(true))
    dblclick()
    expect(container.innerHTML).toMatchSnapshot()
    expect(row().tagName).toBe('DIV')
  })
})
