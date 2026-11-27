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
vi.mock('@/features/extension-ui/StatusStrip', () => ({ StatusStrip: () => null }))
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

/* A reader gets the same locked composer at both widths, naming the holder and offering
 * the take where it types. The wide browser keeps Desktop's control row (only the machine
 * chip, for a reader) above the transcript; a phone keeps that in its lane header. */
it.each([
  ['phone', COMPACT_PLATFORM, true],
  ['wide browser', WIDE_BROWSER_PLATFORM, false],
] as const)('a %s reader gets the same locked composer', async (_name, platform, phone) => {
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
  const lock = el.querySelector('[data-testid="lane-lock"]')
  expect(lock?.textContent).toContain('Desk has control · connected')
  expect(lock?.querySelector('button')?.textContent).toBe('Take over…')
  expect(el.querySelector('[data-testid="composer"]')).toBeNull()
  expect(el.textContent).not.toContain('Controlled by')
  expect(el.textContent?.includes('Studio · Connected')).toBe(!phone)
})
