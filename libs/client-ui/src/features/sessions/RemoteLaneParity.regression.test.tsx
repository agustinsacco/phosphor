// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { RemoteLanes } from './RemoteLanes'
import { HostHome } from '@/features/home/HostHome'
import { RemoteLaneRow } from '@/features/home/RemoteLaneRow'
import { CompactLanes } from '@/shell/compact/CompactLanes'
import { NavigationProvider } from '@/navigation/Navigation'
import { mockRemoteHosts, MOCK_HOST_ID } from '@/dev/mockRemoteLanes'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { useSessionsStore } from '@/stores/sessions'
import { useMachinesStore } from '@/stores/machines'
import {
  createFakePhosphor,
  installFakePhosphor,
} from '../../../../../apps/desktop/test/renderer/helpers/fakePhosphor'

let root: Root, el: HTMLDivElement
let fake: ReturnType<typeof createFakePhosphor>, restore: () => void
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-09-10T12:00:00.000Z'))
  fake = createFakePhosphor({})
  restore = installFakePhosphor(fake)
  useSessionsStore.setState({ live: {}, pinned: [], laneMarkers: {} })
  const host = structuredClone(mockRemoteHosts[MOCK_HOST_ID]!)
  host.repositories.push({ id: '0000000000000002', name: 'Second project', path: '/second' })
  const lane = {
    ...host.lanes[0]!,
    updatedAt: '2026-09-10T11:00:00.000Z',
    activity: 'stopped' as const,
  }
  host.lanes = [
    { ...lane, laneId: 'second', repositoryId: '0000000000000002', title: 'Second lane' },
    { ...lane, laneId: 'first', title: 'First lane', worktree: true, branch: 'feature/parity' },
    { ...lane, laneId: 'orphan', repositoryId: '0000000000000003', title: null },
  ]
  useRemoteLanesStore.setState({ hosts: { [MOCK_HOST_ID]: host }, filter: MOCK_HOST_ID })
  useMachinesStore.setState({
    remoteEnabled: true,
    loading: false,
    error: null,
    machines: [
      {
        id: MOCK_HOST_ID,
        label: 'Test Host',
        hostname: 'test',
        platform: 'linux',
        arch: 'arm64',
        hostVersion: null,
        keyFingerprint: 'test',
        enrolledAt: '2026-09-10T00:00:00.000Z',
        lastSeenAt: null,
        state: null,
        readiness: null,
        lanes: null,
        endpoint: null,
      },
    ],
  })
  el = document.createElement('div')
  document.body.append(el)
  root = createRoot(el)
})
afterEach(() => {
  act(() => root.unmount())
  el.remove()
  restore()
  fake.dispose()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
it.each(['desktop', 'home', 'browser'] as const)(
  '%s groups known repositories in snapshot order and preserves unknown-folder lanes',
  (surface) => {
    act(() =>
      root.render(
        surface === 'desktop' ? (
          <RemoteLanes />
        ) : surface === 'home' ? (
          <HostHome hostId={MOCK_HOST_ID} />
        ) : (
          <NavigationProvider value={{ location: { to: 'lanes' }, navigate: vi.fn() }}>
            <CompactLanes />
          </NavigationProvider>
        ),
      ),
    )
    const text = el.textContent!
    expect(text).toContain('Demo repository')
    expect(text).toContain('Second project')
    expect(text.indexOf('First lane')).toBeLessThan(text.indexOf('Second lane'))
    expect(text).toContain('Unavailable folder')
    expect(text).toContain('Untitled lane')
    expect(text).not.toContain('Needs attention')
    expect(text).not.toContain('stopped')
  },
)
it('browser row uses Desktop elapsed-time, worktree and branch semantics without actions', () => {
  const onOpen = vi.fn()
  const lane = useRemoteLanesStore.getState().hosts[MOCK_HOST_ID]!.lanes[1]!
  act(() => root.render(<RemoteLaneRow lane={lane} onOpen={onOpen} />))
  expect(el.textContent).toContain('1h ago')
  expect(el.querySelector('[data-segment=worktree]')?.textContent).toContain('wt')
  expect(el.querySelector('[data-segment=branch]')?.textContent).toContain('⎇ feature/parity')
  expect(el.querySelector('[data-state=unseen]')).not.toBeNull()
  expect(el.textContent).not.toContain('needs you')
  act(() => el.querySelector('button')!.click())
  expect(onOpen).toHaveBeenCalledOnce()
  expect(el.querySelector('[aria-label="Change lane marker"]')).toBeNull()
})
