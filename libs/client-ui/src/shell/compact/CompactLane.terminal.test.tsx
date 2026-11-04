// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { MOCK_HOST_ID, mockRemoteHosts, mockRemoteInfo } from '@/dev/mockRemoteLanes'
import { COMPACT_PLATFORM, PlatformProvider } from '@/platform/Platform'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { useSessionsStore } from '@/stores/sessions'
import { CompactLane } from './CompactLane'

vi.mock('@/features/chat/ChatView', () => ({ ChatView: () => <p>transcript</p> }))
vi.mock('@/stores/remoteLanes', async (original) => ({
  ...(await original<object>()),
  openRemoteLane: vi.fn(async () => true),
}))

afterEach(() => {
  document.body.innerHTML = ''
  useRemoteLanesStore.setState({ hosts: {}, snapshotStatus: 'idle', filter: 'local' })
  useSessionsStore.setState({ live: {} })
  vi.unstubAllGlobals()
})

it("shows a lane's terminal refusal on a phone in the words Desktop uses (regression)", async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  useRemoteLanesStore.setState({
    hosts: structuredClone(mockRemoteHosts),
    snapshotStatus: 'ready',
    filter: MOCK_HOST_ID,
  })
  useSessionsStore.setState({
    live: {
      [mockRemoteInfo.sessionId]: { ...mockRemoteInfo, phosphorId: mockRemoteInfo.sessionId },
    },
  })
  const el = document.createElement('div')
  document.body.append(el)
  const root = createRoot(el)
  const lane = { hostId: MOCK_HOST_ID, laneId: mockRemoteInfo.laneId! }
  try {
    await act(async () =>
      root.render(
        <PlatformProvider value={COMPACT_PLATFORM}>
          <CompactLane location={{ to: 'lane', lane, pane: 'terminal' }} navigate={() => {}} />
        </PlatformProvider>,
      ),
    )
    // The mock Host grants no terminal capability.
    await vi.waitFor(() =>
      expect(el.textContent).toContain('This Host does not offer terminals to this device.'),
    )
  } finally {
    act(() => root.unmount())
  }
})
