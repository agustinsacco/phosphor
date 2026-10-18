// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { inspectSubagent } from './subagentInspect'
import { useSubagentInspection } from './useSubagentInspection'
vi.mock('./subagentInspect', () => ({ inspectSubagent: vi.fn() }))
const inspect = vi.mocked(inspectSubagent)
let root: Root
let el: HTMLDivElement
let value: ReturnType<typeof useSubagentInspection>
function Probe({ id = 'run', active = true, enabled = true }) {
  value = useSubagentInspection('lane', { runId: id }, enabled, active)
  return <div>{value.inspection?.finalOutput}</div>
}
async function render(props = {}): Promise<void> {
  await act(async () => root.render(<Probe {...props} />))
}
beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.useFakeTimers()
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  inspect.mockReset().mockResolvedValue({ messages: [], truncated: false, finalOutput: 'current' })
  el = document.createElement('div')
  document.body.append(el)
  root = createRoot(el)
})
afterEach(() => {
  act(() => root.unmount())
  el.remove()
  vi.restoreAllMocks()
  vi.useRealTimers()
})
it('refreshes the selected run, reads once on settlement, and stops after closing', async () => {
  await render()
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000)
  })
  expect(inspect).toHaveBeenCalledTimes(2)
  await render({ active: false })
  expect(inspect).toHaveBeenCalledTimes(3)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(20_000)
  })
  expect(inspect).toHaveBeenCalledTimes(3)
  expect(el.textContent).toBe('current')
  await render({ enabled: false })
  expect(vi.getTimerCount()).toBe(0)
})
it('does not overlap a slow inspection or retain another target’s late result', async () => {
  let complete!: (value: Awaited<ReturnType<typeof inspectSubagent>>) => void
  inspect.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        complete = resolve
      }),
  )
  await render()
  await act(async () => {
    await vi.advanceTimersByTimeAsync(20_000)
  })
  expect(inspect).toHaveBeenCalledTimes(1)
  const signal = inspect.mock.calls[0]![3]
  await render({ id: 'other' })
  expect(signal.aborted).toBe(true)
  await act(async () => complete({ messages: [], truncated: false, finalOutput: 'wrong target' }))
  expect(el.textContent).toBe('current')
})
it('pauses polling in a hidden/unfocused window and resumes without changing selection', async () => {
  await render()
  vi.mocked(document.hasFocus).mockReturnValue(false)
  act(() => window.dispatchEvent(new Event('blur')))
  await act(async () => {
    await vi.advanceTimersByTimeAsync(20_000)
  })
  expect(inspect).toHaveBeenCalledTimes(1)
  vi.mocked(document.hasFocus).mockReturnValue(true)
  await act(async () => window.dispatchEvent(new Event('focus')))
  expect(inspect).toHaveBeenCalledTimes(2)
})
it('backs off bounded failures, preserving the last successful read for explicit saving', async () => {
  await render()
  inspect.mockRejectedValue(new Error('Artifacts expired'))
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000 + 15_000 + 30_000)
  })
  expect(inspect).toHaveBeenCalledTimes(4)
  expect(value.error).toContain('expired')
  expect(value.inspection?.finalOutput).toBe('current')
  expect(vi.getTimerCount()).toBe(0)
})
