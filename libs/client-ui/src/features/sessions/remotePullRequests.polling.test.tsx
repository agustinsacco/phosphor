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
import { useRemotePullRequests } from './remotePullRequests'

it('continues repository-wide refreshes after the second minute without summary events', async () => {
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
  const root = createRoot(document.createElement('div'))
  function Group() {
    useRemotePullRequests(MOCK_HOST_ID, host.repositories[0]!.id, true)
    return null
  }
  try {
    await act(async () =>
      root.render(
        <>
          <Group />
          <Group />
        </>,
      ),
    )
    expect(read).toHaveBeenCalledTimes(1)
    await act(async () => vi.advanceTimersByTimeAsync(180_001))
    expect(read).toHaveBeenCalledTimes(4)
  } finally {
    act(() => root.unmount())
    restore()
    fake.dispose()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  }
})
