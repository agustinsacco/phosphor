// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useNow } from './useNow'

let root: Root
let el: HTMLDivElement
let hidden = false
beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.useFakeTimers({ now: 10_000, toFake: ['Date', 'setInterval', 'clearInterval'] })
  hidden = false
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden })
  el = document.createElement('div')
  document.body.append(el)
  root = createRoot(el)
})
afterEach(() => {
  act(() => root.unmount())
  el.remove()
  vi.useRealTimers()
})

function Clock({ enabled }: { enabled: boolean }): React.JSX.Element {
  return <span>{useNow(enabled)}</span>
}

it('ticks only while enabled and the window is visible', () => {
  act(() => root.render(<Clock enabled={false} />))
  act(() => vi.advanceTimersByTime(3_000))
  expect(el.textContent).toBe('10000')
  act(() => root.render(<Clock enabled />))
  expect(el.textContent).toBe('13000')
  act(() => vi.advanceTimersByTime(1_000))
  expect(el.textContent).toBe('14000')
  hidden = true
  act(() => vi.advanceTimersByTime(5_000))
  expect(el.textContent).toBe('14000')
  hidden = false
  act(() => vi.advanceTimersByTime(1_000))
  expect(el.textContent).toBe('20000')
})
