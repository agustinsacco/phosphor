// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { MOCK_HOST_ID, mockRemoteHosts, mockRemoteInfo } from '@/dev/mockRemoteLanes'
import { PlatformProvider, WIDE_BROWSER_PLATFORM } from '@/platform/Platform'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { useSessionsStore } from '@/stores/sessions'
import { CompactLane } from './CompactLane'

vi.mock('@/features/chat/ChatView', () => ({
  ChatView: () => <div data-testid="chat">transcript</div>,
}))
vi.mock('@/stores/remoteLanes', async (original) => ({
  ...(await original<object>()),
  openRemoteLane: vi.fn(async () => true),
}))

const laneId = mockRemoteInfo.laneId!
let root: Root | undefined
afterEach(() => {
  act(() => root?.unmount())
  document.body.innerHTML = ''
  useRemoteLanesStore.setState({ hosts: {}, snapshotStatus: 'idle', filter: 'local' })
  useSessionsStore.setState({ live: {} })
  vi.unstubAllGlobals()
})

it('ends the wide browser lane pane tabs with Session options (regression)', async () => {
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
  root = createRoot(el)
  await act(async () =>
    root!.render(
      <PlatformProvider value={WIDE_BROWSER_PLATFORM}>
        <CompactLane
          location={{ to: 'lane', lane: { hostId: MOCK_HOST_ID, laneId }, pane: 'chat' }}
          navigate={() => {}}
        />
      </PlatformProvider>,
    ),
  )
  const tabs = el.querySelector('.compact-lane-tabs')
  expect(tabs).not.toBeNull()
  const last = [...(tabs?.querySelectorAll('button') ?? [])].at(-1)
  expect(last?.getAttribute('aria-label')).toBe('Session options')
})
