// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { remotePrKey } from '@shared/host-protocol-github'
import {
  createFakePhosphor,
  installFakePhosphor,
} from '../../../../../apps/desktop/test/renderer/helpers/fakePhosphor'
import { mockRemoteHosts, mockRemoteInfo, MOCK_HOST_ID } from '@/dev/mockRemoteLanes'
import { COMPACT_PLATFORM, WIDE_BROWSER_PLATFORM, PlatformProvider } from '@/platform/Platform'
import { NavigationProvider } from '@/navigation/Navigation'
import type { Location } from '@/navigation/location'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { useSessionsStore } from '@/stores/sessions'
import { usePullRequestsStore } from '@/stores/pullRequests'
import { useLanePrefsStore } from '@/stores/lanePrefs'
import { BrowserShell } from './BrowserShell'
vi.hoisted(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: () => ({ matches: false, addEventListener: () => {} }),
  })
})
vi.mock('./CompactLane', () => ({ CompactLane: () => null }))
vi.mock('./CompactNew', () => ({ CompactNew: () => null }))
vi.mock('./CompactSettings', () => ({ CompactSettings: () => null }))
vi.mock('./BrowserNavigation', () => ({ BrowserNavigation: () => null }))

it.each([COMPACT_PLATFORM, WIDE_BROWSER_PLATFORM])(
  'places the same Host PR control outside the title button in the $formFactor browser header',
  async (platform) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    const hosts = structuredClone(mockRemoteHosts)
    const host = hosts[MOCK_HOST_ID]!
    host.capabilities.push('workspaces.read')
    host.lanes[0] = { ...host.lanes[0]!, branch: 'host-branch' }
    const lane = host.lanes[0]!
    const key = remotePrKey(MOCK_HOST_ID, lane.repositoryId)
    useRemoteLanesStore.setState({ hosts, filter: MOCK_HOST_ID })
    useSessionsStore.setState({
      live: {
        [mockRemoteInfo.sessionId]: { ...mockRemoteInfo, phosphorId: mockRemoteInfo.sessionId },
      },
    })
    useLanePrefsStore.getState().applyLanePrefs({ prStatus: true })
    usePullRequestsStore.setState({
      available: false,
      byRepo: {
        [key]: {
          byBranch: {
            'host-branch': {
              number: 13,
              title: 'Host PR',
              state: 'OPEN',
              url: 'https://github.com/example/repo/pull/13',
              checks: null,
            },
          },
          fetchedAt: Date.now(),
          attemptedAt: Date.now(),
          complete: false,
          loading: false,
        },
      },
    })
    const fake = createFakePhosphor()
    const restore = installFakePhosphor(fake)
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    const location: Extract<Location, { to: 'lane' }> = {
      to: 'lane',
      lane: { hostId: MOCK_HOST_ID, laneId: lane.laneId },
    }
    try {
      await act(async () =>
        root.render(
          <PlatformProvider value={platform}>
            <NavigationProvider value={{ location, navigate: vi.fn() }}>
              <BrowserShell pending={false} />
            </NavigationProvider>
          </PlatformProvider>,
        ),
      )
      const pill = container.querySelector<HTMLButtonElement>(
        'header [data-testid="lane-pr-status"]',
      )!
      expect(pill.textContent).toBe('#13')
      expect(pill.parentElement?.closest('button')).toBeNull()
      expect(container.querySelector('header')?.textContent).toContain(lane.title)
      await act(async () => pill.click())
      expect(document.querySelector('[aria-label="Pull request details"]')?.textContent).toContain(
        'Host PR',
      )
    } finally {
      act(() => root.unmount())
      container.remove()
      restore()
      fake.dispose()
      vi.unstubAllGlobals()
    }
  },
)
