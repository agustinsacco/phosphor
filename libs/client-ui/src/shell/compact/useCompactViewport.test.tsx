// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useCompactViewport } from './useCompactViewport'

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
