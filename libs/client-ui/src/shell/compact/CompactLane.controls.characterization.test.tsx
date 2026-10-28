// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { MOCK_HOST_ID, mockRemoteHosts, mockRemoteInfo } from '@/dev/mockRemoteLanes'
import { COMPACT_PLATFORM, PlatformProvider, WIDE_BROWSER_PLATFORM } from '@/platform/Platform'
import { useMachinesStore } from '@/stores/machines'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { useSessionsStore } from '@/stores/sessions'
import { CompactLane } from './CompactLane'

vi.mock('@/features/chat/MessageList', () => ({ MessageList: () => null }))
vi.mock('@/features/chat/Composer', () => ({ Composer: () => <div data-testid="composer" /> }))
vi.mock('@/features/chat/banners', () => ({
  CrashBanner: () => null,
  NoModelsBanner: () => null,
  RewoundBanner: () => null,
}))
vi.mock('@/features/chat/composer/RateLimitBanner', () => ({ RateLimitBanner: () => null }))
vi.mock('@/features/extension-ui/ExtensionUiHosts', () => ({ StatusStrip: () => null }))
vi.mock('@/stores/remoteLanes', async (original) => ({
  ...(await original<object>()),
  openRemoteLane: vi.fn(async () => true),
}))

let root: Root | undefined
afterEach(() => {
  act(() => root?.unmount())
  document.body.innerHTML = ''
  useRemoteLanesStore.setState({ hosts: {}, snapshotStatus: 'idle', filter: 'local' })
  useSessionsStore.setState({ live: {} })
})

/* Where a reader's lane controls sit is the shell's layout. The wide browser keeps
 * Desktop's control row above the transcript; a phone keeps them in its lane header
 * and puts Take control where the composer goes. */
it.each([
  ['phone', COMPACT_PLATFORM, true],
  ['wide browser', WIDE_BROWSER_PLATFORM, false],
] as const)(
  'a %s reader gets the lane controls where its shell places them',
  async (_name, platform, phone) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    const host = structuredClone(mockRemoteHosts[MOCK_HOST_ID]!)
    host.lanes[0]!.control.controller = { label: 'Desk', connected: true, self: false }
    useMachinesStore.setState({ machines: [{ id: MOCK_HOST_ID, label: 'Studio' }] as never })
    useRemoteLanesStore.setState({
      hosts: { [MOCK_HOST_ID]: host },
      snapshotStatus: 'ready',
      filter: MOCK_HOST_ID,
    })
    useSessionsStore.setState({
      live: {
        [mockRemoteInfo.sessionId]: { ...mockRemoteInfo, phosphorId: mockRemoteInfo.sessionId },
      } as never,
    })
    const el = document.createElement('div')
    document.body.append(el)
    root = createRoot(el)
    await act(async () =>
      root!.render(
        <PlatformProvider value={platform}>
          <CompactLane
            location={{
              to: 'lane',
              lane: { hostId: MOCK_HOST_ID, laneId: mockRemoteInfo.laneId! },
              pane: 'chat',
            }}
            navigate={() => {}}
          />
        </PlatformProvider>,
      ),
    )
    expect(el.textContent).toContain('Read-only. Take control to send messages.')
    expect(el.querySelector('[data-testid="composer"]')).toBeNull()
    expect(el.querySelector('.compact-observer') !== null).toBe(phone)
    expect(el.textContent?.includes('Studio · Connected')).toBe(!phone)
  },
)
