// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useBrain } from '@/features/brain/useBrain'
import { mockBrainStatus } from '@/features/brain/mockBrainData'
import { PlatformProvider, WIDE_BROWSER_PLATFORM } from '@/platform/Platform'
import { PageLinks } from './PageLinks'

let container: HTMLDivElement
let root: Root
const onPage = vi.fn()
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const status = mockBrainStatus()
  useBrain.setState({ status })
  vi.stubGlobal('phosphor', { invoke: vi.fn(async () => useBrain.getState().status) })
  container = document.createElement('div')
  root = createRoot(container)
  onPage.mockClear()
})
afterEach(() => {
  act(() => root.unmount())
  vi.unstubAllGlobals()
})

it('puts enabled Brain directly below Machines and opens it using the shared action', async () => {
  useBrain.setState({
    status: { ...mockBrainStatus(), prefs: { enabled: true, recall: true, review: true } },
  })
  await act(async () => root.render(<PageLinks activePage="brain" onPage={onPage} />))
  const buttons = [...container.querySelectorAll('button')]
  const machines = buttons.findIndex((b) => b.textContent === 'Machines')
  expect(buttons[machines + 1]!.textContent).toBe('Brain')
  expect(buttons[machines + 1]!.querySelector('.leading-5')).not.toBeNull()
  await act(async () => buttons[machines + 1]!.click())
  expect(onPage).toHaveBeenCalledWith('brain')
})

it('hides Brain while off and reacts to enabling without hiding other pages', async () => {
  await act(async () => root.render(<PageLinks onPage={onPage} />))
  expect(container.textContent).not.toContain('Brain')
  expect(container.textContent).toContain('Machines')
  act(() =>
    useBrain.setState({
      status: { ...mockBrainStatus(), prefs: { enabled: true, recall: true, review: true } },
    }),
  )
  expect(container.textContent).toContain('Brain')
})

it('does not load or offer local Brain on a browser platform', async () => {
  useBrain.setState({
    status: { ...mockBrainStatus(), prefs: { enabled: true, recall: true, review: true } },
  })
  await act(async () =>
    root.render(
      <PlatformProvider value={WIDE_BROWSER_PLATFORM}>
        <PageLinks onPage={onPage} />
      </PlatformProvider>,
    ),
  )
  expect(container.textContent).not.toContain('Brain')
  expect(window.phosphor.invoke).not.toHaveBeenCalled()
})
