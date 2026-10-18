// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { ModalOverlay } from './Modal'
import { PopupMenu } from './PopupMenu'
import { PlatformProvider, COMPACT_PLATFORM, DESKTOP_PLATFORM } from '@/platform/Platform'

describe.each([DESKTOP_PLATFORM, COMPACT_PLATFORM])('$formFactor primitives', (platform) => {
  it('retains Escape dismissal and adapts portal/menu placement', async () => {
    const container = document.createElement('div')
    document.body.append(container)
    const root = createRoot(container)
    const close = vi.fn()
    await act(async () =>
      root.render(
        <PlatformProvider value={platform}>
          <ModalOverlay onClose={close}>
            <PopupMenu onClose={close}>Choice</PopupMenu>
          </ModalOverlay>
        </PlatformProvider>,
      ),
    )
    expect(!!document.querySelector('[data-compact-sheet]')).toBe(platform.formFactor === 'compact')
    expect(!!document.querySelector('[data-compact-menu]')).toBe(platform.formFactor === 'compact')
    await act(async () => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
    expect(close).toHaveBeenCalledTimes(1)
    await act(async () => root.unmount())
    container.remove()
  })
})
