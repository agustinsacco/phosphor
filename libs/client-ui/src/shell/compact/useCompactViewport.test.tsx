// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { keyboardInset, useCompactViewport } from './useCompactViewport'

let root: Root
const container = document.createElement('div')
function Probe(): null {
  useCompactViewport()
  return null
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  vi.unstubAllGlobals()
})

it('uses compact presentation for a phone and restores the document on unmount', async () => {
  vi.stubGlobal('innerWidth', 412)
  await act(async () => root.render(<Probe />))
  expect(document.documentElement.dataset.formFactor).toBe('compact')
  expect(document.documentElement.style.getPropertyValue('--compact-height')).toBeTruthy()
})

it('switches presentation at wide widths rather than treating browser as always compact', async () => {
  vi.stubGlobal('innerWidth', 1200)
  await act(async () => root.render(<Probe />))
  expect(document.documentElement.dataset.formFactor).toBe('expanded')
  await act(async () => {
    vi.stubGlobal('innerWidth', 412)
    window.dispatchEvent(new Event('resize'))
  })
  expect(document.documentElement.dataset.formFactor).toBe('compact')
})

it('reports what an on-screen keyboard covers, and nothing for a pinch zoom', () => {
  // iOS: the layout viewport keeps its height and the visual one shrinks above the keyboard.
  expect(keyboardInset(844, { height: 508, offsetTop: 0, scale: 1 })).toBe(336)
  // The page panned up under the keyboard: only the remainder below is covered.
  expect(keyboardInset(844, { height: 508, offsetTop: 120, scale: 1 })).toBe(216)
  // Android with `interactive-widget=resizes-content`: both viewports shrink together.
  expect(keyboardInset(508, { height: 508, offsetTop: 0, scale: 1 })).toBe(0)
  expect(keyboardInset(844, { height: 422, offsetTop: 0, scale: 2 })).toBe(0)
  expect(keyboardInset(844, null)).toBe(0)
})

it('publishes the keyboard inset so the bottom safe area can give way to it', async () => {
  vi.stubGlobal('innerWidth', 390)
  const viewport = Object.assign(new EventTarget(), { height: 844, offsetTop: 0, scale: 1 })
  vi.stubGlobal('visualViewport', viewport)
  const layout = vi.spyOn(document.documentElement, 'clientHeight', 'get').mockReturnValue(844)
  const inset = (): string => document.documentElement.style.getPropertyValue('--compact-keyboard')
  await act(async () => root.render(<Probe />))
  expect(inset()).toBe('0px')
  await act(async () => {
    viewport.height = 508
    viewport.dispatchEvent(new Event('resize'))
  })
  expect(inset()).toBe('336px')
  expect(document.documentElement.style.getPropertyValue('--compact-height')).toBe('508px')
  await act(async () => {
    viewport.height = 844
    viewport.dispatchEvent(new Event('resize'))
  })
  expect(inset()).toBe('0px')
  layout.mockRestore()
})
