// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { CompactLanes } from './CompactLanes'
import { NavigationProvider } from '@/navigation/Navigation'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { useMachinesStore } from '@/stores/machines'
import { mockRemoteHosts, MOCK_HOST_ID } from '@/dev/mockRemoteLanes'
import { MACHINE } from '@/features/machines/__fixtures__/control'

it('Inbox shows only workspaces with unread lanes, not false empty-workspace messages', async () => {
  const host = structuredClone(mockRemoteHosts[MOCK_HOST_ID]!)
  host.repositories.push({ id: 'second', name: 'Already read project', path: '/second' })
  host.lanes = [
    { ...host.lanes[0]!, attention: 2, read: 1, title: 'Unread lane' },
    {
      ...host.lanes[0]!,
      laneId: 'read',
      repositoryId: 'second',
      attention: 2,
      read: 2,
      title: 'Read lane',
    },
  ]
  useRemoteLanesStore.setState({ hosts: { [MOCK_HOST_ID]: host }, snapshotStatus: 'ready' })
  useMachinesStore.setState({
    machines: [{ ...MACHINE, id: MOCK_HOST_ID }],
    loading: false,
    error: null,
  })
  const element = document.createElement('div')
  document.body.append(element)
  const root = createRoot(element)
  try {
    await act(async () =>
      root.render(
        <NavigationProvider value={{ location: { to: 'inbox' }, navigate: vi.fn() }}>
          <CompactLanes inbox />
        </NavigationProvider>,
      ),
    )
    expect(element.textContent).toContain('Unread lane')
    expect(element.textContent).not.toContain('Already read project')
    expect(element.textContent).not.toContain('No lanes yet')
    expect(element.textContent).not.toContain('Read lane')
  } finally {
    await act(async () => root.unmount())
    element.remove()
  }
})
