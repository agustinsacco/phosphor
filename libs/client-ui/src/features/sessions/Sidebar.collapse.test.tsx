// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useSessionsStore } from '@/stores/sessions'
import { setGroupCollapsed } from './groupCollapse'
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
