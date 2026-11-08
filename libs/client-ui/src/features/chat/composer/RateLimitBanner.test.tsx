// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useExtensionUiStore } from '@/stores/extensionUi'
import { RateLimitBanner } from './RateLimitBanner'
import { RATE_LIMIT_STATUS_KEY } from './rateLimit'

let root: Root
let el: HTMLDivElement
beforeEach(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  vi.stubGlobal('phosphor', { invoke: vi.fn(() => Promise.resolve(null)) })
  useExtensionUiStore.setState({ statuses: {} })
  el = document.createElement('div')
  document.body.append(el)
  root = createRoot(el)
})
afterEach(() => {
  act(() => root.unmount())
  el.remove()
  vi.unstubAllGlobals()
})

function publish(utilization: number, status = 'allowed'): void {
  const payload = { status, rateLimitType: 'seven_day', utilization }
  act(() =>
    useExtensionUiStore.setState({
      statuses: { lane: { [RATE_LIMIT_STATUS_KEY]: JSON.stringify(payload) } },
    }),
  )
}
function render(): void {
  act(() => root.render(<RateLimitBanner sessionId="lane" />))
}
const banner = (): Element | null => el.querySelector('[data-testid="rate-limit-banner"]')

it('stays quiet below the warning threshold', () => {
  publish(0.4)
  render()
  expect(banner()).toBeNull()
})

it('shows one line naming the window and the share used', () => {
  publish(0.86)
  render()
  expect(banner()?.textContent).toContain('Weekly limit')
  expect(banner()?.textContent).toContain('86% used')
})

it('a dismiss holds for that reading and a worse one reopens it', () => {
  publish(0.86)
  render()
  act(() => el.querySelector<HTMLButtonElement>('button[aria-label="Dismiss"]')!.click())
  expect(banner()).toBeNull()
  publish(0.92)
  expect(banner()?.textContent).toContain('92% used')
})
