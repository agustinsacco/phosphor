// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import {
  createFakePhosphor,
  installFakePhosphor,
} from '../../../../../apps/desktop/test/renderer/helpers/fakePhosphor'
import { useLayoutStore } from '@/stores/layout'
import { useSessionsStore } from '@/stores/sessions'
import { usePullRequestsStore } from '@/stores/pullRequests'
import { useLaneBoard } from './LaneBoard'

function Home() {
  useLaneBoard('/repo')
  return null
}

it('releases a covered Home board and resumes its repository when the global page closes', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.useFakeTimers()
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
  const read = vi.fn(async () => ({ byBranch: {}, complete: true }))
  const fake = createFakePhosphor({ 'gh:prsForRepo': read })
  const restore = installFakePhosphor(fake)
  useLayoutStore.setState({ page: null, sidebarVisible: false })
  useSessionsStore.setState({ live: {}, disk: {}, gitByCwd: {} })
  usePullRequestsStore.setState({ byRepo: {}, available: true })
  const root = createRoot(document.createElement('div'))
  try {
    await act(async () => root.render(<Home />))
    expect(read).toHaveBeenCalledTimes(1)
    await act(async () => useLayoutStore.getState().setPage('skills'))
    await act(async () => vi.advanceTimersByTimeAsync(120_001))
    expect(read).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
    await act(async () => useLayoutStore.getState().setPage(null))
    expect(read).toHaveBeenCalledTimes(2)
    await act(async () => vi.advanceTimersByTimeAsync(60_001))
    expect(read).toHaveBeenCalledTimes(3)
  } finally {
    act(() => root.unmount())
    restore()
    fake.dispose()
    vi.restoreAllMocks()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  }
})
