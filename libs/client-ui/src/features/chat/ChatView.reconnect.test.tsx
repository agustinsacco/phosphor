// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { MOCK_HOST_ID, mockRemoteHosts, mockRemoteInfo } from '@/dev/mockRemoteLanes'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { useSessionsStore } from '@/stores/sessions'
import type { HostConnectionView } from '@phosphor/shared/ipc'
import { ChatView } from './ChatView'

vi.mock('./MessageList', () => ({ MessageList: () => null }))
vi.mock('./Composer', () => ({ Composer: () => <div data-testid="composer" /> }))
vi.mock('./banners', () => ({
  CrashBanner: () => null,
  NoModelsBanner: () => null,
  RewoundBanner: () => null,
}))
vi.mock('./composer/RateLimitBanner', () => ({ RateLimitBanner: () => null }))
vi.mock('@/features/extension-ui/ExtensionUiHosts', () => ({ StatusStrip: () => null }))

let root: Root | undefined
afterEach(() => {
  act(() => root?.unmount())
  document.body.innerHTML = ''
  useRemoteLanesStore.setState({ hosts: {} })
  useSessionsStore.setState({ live: {} })
})

async function render(self: boolean): Promise<HTMLElement> {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const host = structuredClone(mockRemoteHosts[MOCK_HOST_ID]!)
  host.lanes[0]!.control.controller = { label: 'Phone', connected: true, self }
  useRemoteLanesStore.setState({ hosts: { [MOCK_HOST_ID]: host } })
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
      <ChatView
        sessionId={mockRemoteInfo.sessionId}
        workspacePath={mockRemoteInfo.workspacePath}
      />,
    ),
  )
  return el
}
const setState = (state: HostConnectionView['state']) =>
  act(async () => {
    const host = useRemoteLanesStore.getState().hosts[MOCK_HOST_ID]!
    useRemoteLanesStore.setState({ hosts: { [MOCK_HOST_ID]: { ...host, state } } })
  })

/* The composer says what it waits for (Composer.renders.test.tsx). Around it, a lane that
 * is only reconnecting must not claim to be read-only or offer control it cannot take. */
it.each([true, false])(
  'waits on the composer while the Host reconnects, controller: %s',
  async (self) => {
    const el = await render(self)
    for (const state of ['reconnecting', 'connecting'] as const) {
      await setState(state)
      expect(el.querySelector('[data-testid="composer"]')).not.toBeNull()
      expect(el.textContent).not.toContain('Read-only')
      expect(el.textContent).not.toContain('Machine not connected')
      expect(el.querySelectorAll('button')).toHaveLength(0)
    }
    await setState('ready')
    expect(!!el.querySelector('[data-testid="composer"]')).toBe(self)
    expect(el.textContent?.includes('Read-only. Take control to send messages.')).toBe(!self)
  },
)
