// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useMachinesStore } from '@/stores/machines'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { useSessionsStore } from '@/stores/sessions'
import { useWorkspacesStore } from '@/stores/workspaces'
import { setGroupCollapsed } from './groupCollapse'
import { Sidebar } from './Sidebar'

vi.mock('@/lib/monaco', () => ({}))
let root: Root
let container: HTMLDivElement
const invoke = vi.fn()

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
        ? {}
        : channel === 'routines:laneIndex'
          ? {}
          : channel === 'git:listWorktrees' || channel === 'sessions:list'
            ? []
            : null,
    )
  useMachinesStore.setState({ remoteEnabled: false, machines: [], adding: false })
  useRemoteLanesStore.setState({ hosts: {}, filter: 'local', error: null })
  useWorkspacesStore.setState({
    recents: [{ path: '/repo', name: 'repo', lastOpenedAt: 0 }],
    hydrated: true,
  })
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
