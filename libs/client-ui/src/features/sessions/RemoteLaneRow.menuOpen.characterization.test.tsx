// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { RemoteLaneRow } from './RemoteLaneRow'
import { useHostLaneOpensStore } from '@/stores/hostLaneOpen'
import { refreshHostsSnapshot } from '@/stores/hostsSnapshotRead'

vi.mock('@/stores/hostsSnapshotRead', () => ({ refreshHostsSnapshot: vi.fn(async () => {}) }))
import { ContextMenuHost } from '@/components/ContextMenu'
import { mockRemoteHosts, mockRemoteInfo, MOCK_HOST_ID } from '@/dev/mockRemoteLanes'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { useSessionsStore } from '@/stores/sessions'
import { useChatStore } from '@/stores/chat'
let root: Root, container: HTMLDivElement
const invoke = vi.fn(),
  command = vi.fn()
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('phosphor', { invoke, piCommand: command })
  invoke.mockReset().mockResolvedValue({ branchKept: false })
  command.mockReset().mockResolvedValue({ success: true })
  const hosts = structuredClone(mockRemoteHosts)
  hosts[MOCK_HOST_ID]!.capabilities.push('workspaces.write')
  hosts[MOCK_HOST_ID]!.lanes[0]!.control.controller = { self: true, label: 'You', connected: true }
  useRemoteLanesStore.setState({ hosts })
  useSessionsStore.setState({
    live: {
      [mockRemoteInfo.sessionId]: { ...mockRemoteInfo, phosphorId: mockRemoteInfo.sessionId },
    },
    activeSessionId: mockRemoteInfo.sessionId,
  })
  useChatStore.getState().ensure(mockRemoteInfo.sessionId)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})
function render(ready = true): void {
  act(() =>
    root.render(
      <>
        <RemoteLaneRow
          hostId={MOCK_HOST_ID}
          lane={useRemoteLanesStore.getState().hosts[MOCK_HOST_ID]!.lanes[0]!}
          ready={ready}
          active
        />
        <ContextMenuHost />
      </>,
    ),
  )
}
function menu(): void {
  act(() => {
    container
      .querySelector('button')!
      .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }))
  })
}
function button(text: string): HTMLButtonElement {
  const found = [...document.querySelectorAll('button')].find((b) =>
    b.textContent?.trim().startsWith(text),
  )
  if (!found) throw new Error(text)
  return found
}

/* A menu action on a Host lane this client has not opened opens and adopts it
   in place: no navigation, no opening state on the row, no snapshot refresh. */
it('opens and adopts an unopened lane for a menu action without navigating to it', async () => {
  const adoptSession = vi.fn(async () => {})
  useSessionsStore.setState({ live: {}, activeSessionId: null, adoptSession } as never)
  const info = { ...mockRemoteInfo, sessionId: 'opened-1' }
  invoke.mockImplementation(async (channel: string) =>
    channel === 'hosts:openLane' ? info : { branchKept: false },
  )
  command.mockResolvedValue({ success: true, data: { cost: 1.5 } })
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: vi.fn(async () => {}) },
  })
  const flights: Record<string, true>[] = []
  const stop = useHostLaneOpensStore.subscribe((s) => flights.push(s.inFlight))
  render()
  menu()
  await act(async () => button('Copy spend').click())
  stop()
  const laneId = useRemoteLanesStore.getState().hosts[MOCK_HOST_ID]!.lanes[0]!.laneId
  expect(invoke.mock.calls.filter(([c]) => c === 'hosts:openLane')).toEqual([
    ['hosts:openLane', MOCK_HOST_ID, laneId],
  ])
  expect(adoptSession).toHaveBeenCalledWith('opened-1', info.workspacePath, undefined, info)
  expect(flights).toEqual([])
  expect(useSessionsStore.getState().activeSessionId).toBeNull()
  expect(refreshHostsSnapshot).not.toHaveBeenCalled()
})
