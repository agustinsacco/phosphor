// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { HostLaneBranchControl } from './HostLaneBranchControl'
import { mockRemoteHosts, mockRemoteInfo, MOCK_HOST_ID } from '@/dev/mockRemoteLanes'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { useRemoteComposer } from '@/features/home/remoteComposer'
vi.mock('./BranchControl', () => ({
  BranchControl: ({
    workspacePath,
    selectPath,
  }: {
    workspacePath: string
    selectPath: (path: string) => void
  }) => <button onClick={() => selectPath('/configured')}>{workspacePath}</button>,
}))
it('uses the ready local projection for native Git, else the read-only branch chip, and selects the configured folder on that Host', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('phosphor', { invoke: vi.fn().mockResolvedValue(undefined) })
  const host = structuredClone(mockRemoteHosts[MOCK_HOST_ID]!)
  host.repositories = [{ ...host.repositories[0]!, path: '/configured' }]
  host.lanes[0] = { ...host.lanes[0]!, branch: 'main' }
  const el = document.createElement('div'),
    root = createRoot(el)
  try {
    for (const local of [false, true]) {
      useRemoteLanesStore.setState({
        hosts: { [MOCK_HOST_ID]: { ...host, ...(local ? { local: true as const } : {}) } },
      })
      act(() =>
        root.render(
          <HostLaneBranchControl hostId={MOCK_HOST_ID} laneId={mockRemoteInfo.laneId!} />,
        ),
      )
      expect(el.textContent).toBe(local ? host.lanes[0]!.cwd : 'main')
      expect(el.querySelector('[data-testid="lane-branch"]') === null).toBe(local)
    }
    act(() => el.querySelector('button')!.click())
    expect(useRemoteComposer.getState().target).toEqual({
      hostId: MOCK_HOST_ID,
      repositoryId: host.repositories[0]!.id,
    })
  } finally {
    act(() => root.unmount())
    vi.unstubAllGlobals()
  }
})
