// @vitest-environment jsdom
import { describe, it, expect, beforeAll, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
vi.hoisted(() => {
  // The settings store, imported along the way, follows the system theme.
  window.matchMedia = (() => ({
    matches: false,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia
})

import { LANE_RELOAD_STATUS_KEY } from '@phosphor/pi-extensions/lane-reload'
import { useExtensionUiStore } from '@/stores/extensionUi'
import { StatusStrip } from './ExtensionUiHosts'

beforeAll(() => {
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

describe('StatusStrip', () => {
  it('shows extension statuses but never a host reply channel', () => {
    useExtensionUiStore.setState({
      statuses: {
        s1: {
          [LANE_RELOAD_STATUS_KEY]: '{"token":"t","outcome":"applied"}',
          'some-extension': 'indexing',
        },
      },
    })
    const container = document.createElement('div')
    const root = createRoot(container)
    act(() => root.render(<StatusStrip sessionId="s1" />))
    expect(container.textContent).toContain('indexing')
    expect(container.textContent).not.toContain('applied')
    act(() => root.unmount())
  })
})
