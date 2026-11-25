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

function hostLaneWithPr(): string {
  const hosts = structuredClone(mockRemoteHosts)
  const host = hosts[MOCK_HOST_ID]!
  host.lanes[0] = { ...host.lanes[0]!, branch: 'host-branch', worktree: true }
  const lane = host.lanes[0]
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
      [remotePrKey(MOCK_HOST_ID, lane.repositoryId)]: {
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
  return lane.laneId
}

it.each([WIDE_BROWSER_PLATFORM, COMPACT_PLATFORM])(
  'orders the $formFactor browser lane header like Desktop, with no project badge',
  async (platform) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    const laneId = hostLaneWithPr()
    const fake = createFakePhosphor()
    const restore = installFakePhosphor(fake)
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    const location: Extract<Location, { to: 'lane' }> = {
      to: 'lane',
      lane: { hostId: MOCK_HOST_ID, laneId },
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
      const header = container.querySelector('header')!
      expect(header.textContent).not.toContain('Demo repository')
      expect(header.textContent).not.toContain('Swarm')
      if (platform.formFactor === 'compact') {
        // The phone keeps its own header: the title button carries the Host line.
        expect(header.querySelector('[data-testid="machine-chip"]')).toBeNull()
        expect(header.querySelector('[data-testid="lane-branch"]')).toBeNull()
        return
      }
      const nodes = [
        header.querySelector('[data-testid="machine-chip"]'),
        header.querySelector('[data-testid="lane-branch"]'),
        header.querySelector('strong'),
        header.querySelector('[data-testid="lane-pr-status"]'),
      ]
      for (const node of nodes) expect(node).toBeTruthy()
      for (let i = 1; i < nodes.length; i++)
        expect(
          nodes[i - 1]!.compareDocumentPosition(nodes[i]!) & Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
      expect(nodes[0]!.textContent).toBe(`${MOCK_HOST_ID} · Connected`)
      expect(nodes[1]!.textContent).toBe('wthost-branch')
      expect(nodes[2]!.textContent).toBe('Remote demo lane')
    } finally {
      act(() => root.unmount())
      container.remove()
      restore()
      fake.dispose()
      vi.unstubAllGlobals()
    }
  },
)
