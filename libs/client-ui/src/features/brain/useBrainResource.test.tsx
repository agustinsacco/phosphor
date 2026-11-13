// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useBrainResource } from './useBrainResource'
import { useBrain } from './useBrain'
import { mockBrainStatus } from './mockBrainData'
let root: Root
let container: HTMLDivElement
const load = vi.fn<() => Promise<string>>()
function Consumer(): React.JSX.Element {
  const { data, error, retry } = useBrainResource(load)
  return (
    <div>
      {data || error}
      <input aria-label="Retry resource" type="button" onClick={retry} />
    </div>
  )
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  useBrain.setState({ status: mockBrainStatus() })
  load.mockReset().mockResolvedValue('Harbor')
  container = document.createElement('div')
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  vi.unstubAllGlobals()
})
it('reloads on generation change even when revision repeats', async () => {
  await act(async () => root.render(<Consumer />))
  expect(load).toHaveBeenCalledTimes(1)
  await act(async () =>
    useBrain.setState({ status: { ...mockBrainStatus(), generation: 'reset-again' } }),
  )
  expect(load).toHaveBeenCalledTimes(2)
})
it('recovers a failed first load and reloads on revision changes', async () => {
  load.mockRejectedValueOnce(new Error('Harbor unavailable'))
  await act(async () => root.render(<Consumer />))
  expect(container.textContent).toContain('Harbor unavailable')
  await act(async () => container.querySelector<HTMLInputElement>('input')!.click())
  expect(container.textContent).toBe('Harbor')
  await act(async () => useBrain.setState({ status: { ...mockBrainStatus(), revision: 2 } }))
  expect(load).toHaveBeenCalledTimes(3)
})
