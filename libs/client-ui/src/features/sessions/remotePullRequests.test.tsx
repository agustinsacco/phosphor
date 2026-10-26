// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import {
  createFakePhosphor,
  installFakePhosphor,
} from '../../../../../apps/desktop/test/renderer/helpers/fakePhosphor'
import { mockRemoteHosts, MOCK_HOST_ID } from '@/dev/mockRemoteLanes'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { usePullRequestsStore } from '@/stores/pullRequests'
import { remotePrKey } from '@shared/host-protocol-github'
import { useRemotePullRequests } from './remotePullRequests'

it('keeps shared cache through navigation, refreshes a throttled summary change, and clears on Host removal', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.useFakeTimers()
  const hosts = structuredClone(mockRemoteHosts)
  const host = hosts[MOCK_HOST_ID]!
  host.capabilities.push('workspaces.read')
  useRemoteLanesStore.setState({ hosts })
  usePullRequestsStore.setState({ byRepo: {}, available: false })
  const read = vi.fn(async () => ({ byBranch: {}, complete: true }))
  const fake = createFakePhosphor({ 'gh:prsForRepo': read })
  const restore = installFakePhosphor(fake)
  const div = document.createElement('div')
  const root = createRoot(div)
  const key = remotePrKey(MOCK_HOST_ID, host.repositories[0]!.id)
  function Group() {
    useRemotePullRequests(MOCK_HOST_ID, host.repositories[0]!.id, true)
    return null
  }
  try {
    await act(async () =>
      root.render(
        <>
          <Group key="sidebar" />
          <Group key="home" />
        </>,
      ),
    )
    expect(read).toHaveBeenCalledTimes(1)
    await act(async () => root.render(<Group key="sidebar" />))
    expect(usePullRequestsStore.getState().byRepo[key]?.complete).toBe(true)
    await act(async () =>
      useRemoteLanesStore.setState({
        hosts: { [MOCK_HOST_ID]: { ...host, lanes: [...host.lanes] } },
      }),
    )
    expect(read).toHaveBeenCalledTimes(1)
    await act(async () => vi.advanceTimersByTimeAsync(60_001))
    expect(read).toHaveBeenCalledTimes(2)
    await act(async () => useRemoteLanesStore.setState({ hosts: {} }))
    expect(usePullRequestsStore.getState().byRepo[key]).toBeUndefined()
  } finally {
    act(() => root.unmount())
    restore()
    fake.dispose()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  }
})
