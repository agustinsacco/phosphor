// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { ServiceLaneBranchControl } from './ServiceLaneBranchControl'
import { mockRemoteHosts, mockRemoteInfo, MOCK_HOST_ID } from '@/dev/mockRemoteLanes'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { useSessionsStore } from '@/stores/sessions'
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
it('uses the ready local projection for native Git and selects the configured folder on that Host', () => {
  const host = structuredClone(mockRemoteHosts[MOCK_HOST_ID]!)
  const sessionId = mockRemoteInfo.sessionId
  host.repositories = [{ ...host.repositories[0]!, path: '/configured' }]
  useSessionsStore.setState({ live: { [sessionId]: { ...mockRemoteInfo, phosphorId: sessionId } } })
  const el = document.createElement('div'),
    root = createRoot(el)
  try {
    for (const local of [false, true]) {
      useRemoteLanesStore.setState({
        hosts: { [MOCK_HOST_ID]: { ...host, ...(local ? { local: true as const } : {}) } },
      })
      act(() => root.render(<ServiceLaneBranchControl sessionId={sessionId} />))
      expect(el.textContent).toBe(local ? host.lanes[0]!.cwd : '')
    }
    act(() => el.querySelector('button')!.click())
    expect(useRemoteComposer.getState().target).toEqual({
      hostId: MOCK_HOST_ID,
      repositoryId: host.repositories[0]!.id,
    })
  } finally {
    act(() => root.unmount())
  }
})
