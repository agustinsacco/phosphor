// @vitest-environment jsdom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mockRemoteHosts, mockRemoteInfo, MOCK_HOST_ID } from '@/dev/mockRemoteLanes'
import { navigateToLane, useRemoteLanesStore } from '@/stores/remoteLanes'
import { useSessionsStore } from '@/stores/sessions'
import { useLayoutStore } from '@/stores/layout'
import { remoteLaneGroupKey, useLaneReveal, useLaneRevealStore } from './laneReveal'

vi.mock('@/lib/monaco', () => ({ languageForPath: () => 'plaintext' }))
vi.mock('@/features/artifacts/remoteArtifactRefresh', () => ({
  bindRemoteHostView: () => {},
  refreshRemoteArtifacts: async () => {},
  invalidateRemoteArtifactReads: () => {},
}))

function HostGroup({ hostId, repositoryId }: { hostId: string; repositoryId: string }) {
  const [collapsed, setCollapsed] = useState(true)
  const [search, setSearch] = useState('filtered')
  const key = remoteLaneGroupKey(hostId, repositoryId)
  useLaneReveal(key, () => {
    setCollapsed(false)
    setSearch('')
  })
  return (
    <section aria-label={key}>
      {collapsed ? 'collapsed' : 'expanded'}:{search}
    </section>
  )
}

let root: Root | undefined
let container: HTMLDivElement
let previousBridge: PropertyDescriptor | undefined
beforeEach(() => {
  previousBridge = Object.getOwnPropertyDescriptor(window, 'phosphor')
  Object.defineProperty(window, 'phosphor', {
    configurable: true,
    value: { invoke: vi.fn(async () => mockRemoteInfo) },
  })
  useSessionsStore.setState({ live: {}, activeSessionId: null, navSeq: 0 })
  useLayoutStore.setState({ page: 'skills' })
  useRemoteLanesStore.setState({ hosts: structuredClone(mockRemoteHosts), filter: 'local' })
  useLaneRevealStore.setState({ seq: 0, groupKey: null })
  vi.spyOn(useSessionsStore.getState(), 'adoptSession').mockImplementation(async () => {
    useSessionsStore.setState({
      live: {
        [mockRemoteInfo.sessionId]: {
          phosphorId: mockRemoteInfo.sessionId,
          workspacePath: mockRemoteInfo.workspacePath,
          target: mockRemoteInfo.target,
          laneId: mockRemoteInfo.laneId,
        },
      },
    })
  })
  container = document.createElement('div')
  root = createRoot(container)
})
afterEach(() => {
  act(() => root?.unmount())
  vi.restoreAllMocks()
  if (previousBridge) Object.defineProperty(window, 'phosphor', previousBridge)
  else Reflect.deleteProperty(window, 'phosphor')
})

it('navigation expands and clears only the matching rendered Host repository group', async () => {
  const lane = mockRemoteHosts[MOCK_HOST_ID]?.lanes[0]
  if (!lane || !mockRemoteInfo.laneId) throw new Error('Missing fixture lane')
  const otherHost = 'other-host'
  const otherRepository = 'other-repository'
  act(() =>
    root?.render(
      <>
        <HostGroup hostId={MOCK_HOST_ID} repositoryId={lane.repositoryId} />
        <HostGroup hostId={otherHost} repositoryId={lane.repositoryId} />
        <HostGroup hostId={MOCK_HOST_ID} repositoryId={otherRepository} />
      </>,
    ),
  )
  await act(async () => {
    expect(
      await navigateToLane({ hostId: MOCK_HOST_ID, laneId: mockRemoteInfo.laneId ?? '' }),
    ).toBe(true)
  })
  const content = (hostId: string, repositoryId: string) =>
    container.querySelector(`[aria-label="${remoteLaneGroupKey(hostId, repositoryId)}"]`)
      ?.textContent
  expect(content(MOCK_HOST_ID, lane.repositoryId)).toBe('expanded:')
  expect(content(otherHost, lane.repositoryId)).toBe('collapsed:filtered')
  expect(content(MOCK_HOST_ID, otherRepository)).toBe('collapsed:filtered')
})
