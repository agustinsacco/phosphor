// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  createFakePhosphor,
  installFakePhosphor,
} from '../../../../../apps/desktop/test/renderer/helpers/fakePhosphor'
import { usePullRequestsStore } from '@/stores/pullRequests'
import { useRepoPrRefresh } from './repoPrRefresh'

let root: Root
let restore: () => void
let dispose: () => void
let hidden = false
const read = vi.fn(async (_repo: string) => ({ byBranch: {}, complete: true }))
function Consumer({ repos, revision }: { repos: string[]; revision?: unknown }) {
  useRepoPrRefresh(repos, revision)
  return null
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.useFakeTimers()
  hidden = false
  vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden)
  usePullRequestsStore.setState({ byRepo: {}, available: true })
  read.mockReset().mockResolvedValue({ byBranch: {}, complete: true })
  const fake = createFakePhosphor({ 'gh:prsForRepo': read })
  restore = installFakePhosphor(fake)
  dispose = fake.dispose
  root = createRoot(document.createElement('div'))
})
afterEach(() => {
  act(() => root.unmount())
  restore()
  dispose()
  vi.restoreAllMocks()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

it('shares one clock across consumers and polls only retained repositories', async () => {
  await act(async () =>
    root.render(
      <>
        <Consumer repos={['/repo', '/other']} />
        <Consumer repos={['/repo']} />
      </>,
    ),
  )
  expect(read.mock.calls.map(([repo]) => repo)).toEqual(['/other', '/repo'])
  expect(vi.getTimerCount()).toBe(1)
  await act(async () => vi.advanceTimersByTimeAsync(120_001))
  expect(read).toHaveBeenCalledTimes(6)
  await act(async () => root.render(<Consumer repos={['/repo']} />))
  await act(async () => vi.advanceTimersByTimeAsync(60_001))
  expect(read).toHaveBeenCalledTimes(7)
  expect(read.mock.lastCall).toEqual(['/repo'])
})

it('pauses hidden, resumes stale once, coalesces focus, and removes timers/listeners on cleanup', async () => {
  await act(async () => root.render(<Consumer repos={['/repo']} />))
  hidden = true
  await act(async () => document.dispatchEvent(new Event('visibilitychange')))
  expect(vi.getTimerCount()).toBe(0)
  await act(async () => vi.advanceTimersByTimeAsync(180_000))
  await act(async () => window.dispatchEvent(new Event('focus')))
  expect(read).toHaveBeenCalledTimes(1)
  hidden = false
  await act(async () => document.dispatchEvent(new Event('visibilitychange')))
  await act(async () => window.dispatchEvent(new Event('focus')))
  expect(read).toHaveBeenCalledTimes(2)
  await act(async () => root.render(null))
  expect(vi.getTimerCount()).toBe(0)
  await act(async () => {
    window.dispatchEvent(new Event('focus'))
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(120_000)
  })
  expect(read).toHaveBeenCalledTimes(2)
})

it('does not fetch on hidden mount and recovers from a failed first read on the next tick', async () => {
  hidden = true
  read.mockRejectedValueOnce(new Error('offline'))
  await act(async () => root.render(<Consumer repos={['/repo']} />))
  expect(read).not.toHaveBeenCalled()
  hidden = false
  await act(async () => document.dispatchEvent(new Event('visibilitychange')))
  expect(usePullRequestsStore.getState().byRepo['/repo']?.failed).toBe(true)
  await act(async () => vi.advanceTimersByTimeAsync(60_001))
  expect(read).toHaveBeenCalledTimes(2)
  expect(usePullRequestsStore.getState().byRepo['/repo']?.failed).toBe(false)
})

it('requests stale refresh on settlement/summary changes but coalesces fresh same-repo navigation', async () => {
  await act(async () => root.render(<Consumer repos={['/repo']} revision="lane-a" />))
  await act(async () => root.render(<Consumer repos={['/repo', '/repo']} revision="lane-b" />))
  expect(read).toHaveBeenCalledTimes(1)
  usePullRequestsStore.setState((s) => ({
    byRepo: { '/repo': { ...s.byRepo['/repo']!, attemptedAt: Date.now() - 60_001 } },
  }))
  await act(async () => root.render(<Consumer repos={['/repo']} revision="settled" />))
  expect(read).toHaveBeenCalledTimes(2)
})
