// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { PlatformProvider, WIDE_BROWSER_PLATFORM } from '@/platform/Platform'
import { useExtensionUiStore } from '@/stores/extensionUi'
import { brainInFlight, useBrain, useBrainSync } from './useBrain'
import { mockBrainJob, mockBrainStatus } from './mockBrainData'

let root: Root
const invoke = vi.fn()
function Consumer(): React.JSX.Element {
  useBrainSync()
  return <></>
}
beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
  invoke.mockReset().mockResolvedValue(mockBrainStatus())
  vi.stubGlobal('phosphor', { invoke })
  useBrain.setState({ status: null, saving: false, error: '' })
  useExtensionUiStore.setState({ toasts: [] })
  root = createRoot(document.createElement('div'))
})
afterEach(() => {
  act(() => root.unmount())
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

it('loads once for multiple consumers and does not poll idle or review-only status', async () => {
  await act(async () =>
    root.render(
      <>
        <Consumer />
        <Consumer />
      </>,
    ),
  )
  expect(invoke).toHaveBeenCalledTimes(1)
  await act(async () => vi.advanceTimersByTimeAsync(10000))
  expect(invoke).toHaveBeenCalledTimes(1)
  act(() => useBrain.setState({ status: { ...mockBrainStatus(), jobs: [mockBrainJob()] } }))
  await act(async () => vi.advanceTimersByTimeAsync(10000))
  expect(invoke).toHaveBeenCalledTimes(1)
})

it('polls in-flight work every two seconds, stops while hidden and on completion', async () => {
  const busy = { ...mockBrainStatus(), jobs: [mockBrainJob({ state: 'running' })] }
  invoke.mockResolvedValue(busy)
  await act(async () => root.render(<Consumer />))
  await act(async () => vi.advanceTimersByTimeAsync(1999))
  expect(invoke).toHaveBeenCalledTimes(1)
  await act(async () => vi.advanceTimersByTimeAsync(1))
  expect(invoke).toHaveBeenCalledTimes(2)
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await act(async () => vi.advanceTimersByTimeAsync(10000))
  expect(invoke).toHaveBeenCalledTimes(2)
  invoke.mockResolvedValue(mockBrainStatus())
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
  await act(async () => document.dispatchEvent(new Event('visibilitychange')))
  expect(invoke).toHaveBeenCalledTimes(3)
  await act(async () => vi.advanceTimersByTimeAsync(10000))
  expect(invoke).toHaveBeenCalledTimes(3)
})

it('classifies download, verification, testing and all queued job states as in flight', () => {
  const status = mockBrainStatus()
  expect(brainInFlight(null)).toBe(false)
  for (const phase of ['downloading', 'verifying', 'testing'] as const)
    expect(brainInFlight({ ...status, embedding: { ...status.embedding, phase } })).toBe(true)
  for (const state of ['waiting', 'queued', 'running'] as const)
    expect(brainInFlight({ ...status, jobs: [mockBrainJob({ state })] })).toBe(true)
  for (const state of ['review', 'empty', 'failed', 'done'] as const)
    expect(brainInFlight({ ...status, jobs: [mockBrainJob({ state })] })).toBe(false)
})

it('cleans up polling on unmount and never calls IPC on unsupported platforms', async () => {
  invoke.mockResolvedValue({ ...mockBrainStatus(), jobs: [mockBrainJob({ state: 'waiting' })] })
  await act(async () => root.render(<Consumer />))
  await act(async () =>
    root.render(
      <PlatformProvider value={WIDE_BROWSER_PLATFORM}>
        <Consumer />
      </PlatformProvider>,
    ),
  )
  invoke.mockClear()
  await act(async () => vi.advanceTimersByTimeAsync(10000))
  expect(invoke).not.toHaveBeenCalled()
})

it('keeps unsupported status null and reports refresh and action failures in toasts', async () => {
  invoke.mockResolvedValue({ ...mockBrainStatus(), supported: false })
  await useBrain.getState().refresh()
  expect(useBrain.getState().status).toBeNull()
  invoke.mockRejectedValue(new Error('Demo service failed'))
  await useBrain.getState().refresh()
  expect(useBrain.getState().error).toBe('Demo service failed')
  expect(await useBrain.getState().download()).toBe(false)
  expect(useBrain.getState().saving).toBe(false)
  expect(
    useExtensionUiStore
      .getState()
      .toasts.some((toast) => toast.message === 'Demo service failed' && toast.kind === 'error'),
  ).toBe(true)
})

it('stores each mutation’s returned status and confirms queue, cancel and forget', async () => {
  const status = { ...mockBrainStatus(), revision: 4 }
  invoke.mockResolvedValue(status)
  const store = useBrain.getState()
  const lane = { sessionPath: '/demo/Harbor/lane.jsonl', title: 'Harbor billing' }
  await store.setPrefs(status.prefs)
  await store.download()
  await store.removeModel()
  await store.queue(lane)
  await store.cancel('job')
  await store.review('job', [0], 3)
  await store.forget('memory')
  expect(invoke.mock.calls).toEqual([
    ['brain:setPrefs', status.prefs],
    ['brain:download'],
    ['brain:removeModel'],
    ['brain:queue', lane],
    ['brain:cancel', 'job'],
    ['brain:review', 'job', [0], 3],
    ['brain:forget', 'memory'],
  ])
  expect(useBrain.getState().status).toEqual(status)
  expect(useExtensionUiStore.getState().toasts.map((toast) => toast.message)).toContain(
    'Queued Harbor billing for knowledge extraction',
  )
})

it('does not let an older status request overwrite an action’s returned status', async () => {
  let resolve!: (status: ReturnType<typeof mockBrainStatus>) => void
  invoke.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done
      }),
  )
  const reading = useBrain.getState().refresh()
  const enabled = { ...mockBrainStatus(), prefs: { enabled: true, recall: true, review: true } }
  invoke.mockResolvedValue(enabled)
  await useBrain.getState().setPrefs(enabled.prefs)
  resolve(mockBrainStatus())
  await reading
  expect(useBrain.getState().status?.prefs.enabled).toBe(true)
})
