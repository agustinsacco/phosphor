// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  COMPACT_PLATFORM,
  DESKTOP_PLATFORM,
  WIDE_BROWSER_PLATFORM,
  PlatformProvider,
  type Platform,
} from '@/platform/Platform'
import { ContextMenuHost } from './ContextMenu'
import { ImageButton, ImageLightboxActions, ImageLightboxFrame } from './ImageActions'

let root: Root
let container: HTMLDivElement
const onCopy = vi.fn()
const onSave = vi.fn()
const onOpen = vi.fn()
beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  vi.clearAllMocks()
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})
function render(platform: Platform): void {
  act(() =>
    root.render(
      <PlatformProvider value={platform}>
        <ContextMenuHost />
        <ImageButton annotate={false} onCopy={onCopy} onSave={onSave} onClick={onOpen}>
          Image
        </ImageButton>
        <ImageLightboxActions onCopy={onCopy} onSave={onSave} />
      </PlatformProvider>,
    ),
  )
}
const buttons = (): HTMLButtonElement[] => [...document.querySelectorAll('button')]

it('opens the copy/save sheet on phone long-press without opening the lightbox', () => {
  vi.useFakeTimers()
  vi.stubGlobal('navigator', { clipboard: { write() {} } })
  vi.stubGlobal('ClipboardItem', class {})
  render(COMPACT_PLATFORM)
  const trigger = container.querySelector('button')!
  expect(trigger.getAttribute('data-tooltip-description')).toBeNull()
  const down = new MouseEvent('pointerdown', { bubbles: true, clientX: 20, clientY: 20 })
  Object.defineProperty(down, 'pointerType', { value: 'touch' })
  act(() => {
    trigger.dispatchEvent(down)
    vi.advanceTimersByTime(500)
  })
  expect(document.querySelector('[data-testid="context-menu-sheet"]')?.textContent).toContain(
    'Copy imageSave image',
  )
  act(() => trigger.click())
  expect(onOpen).not.toHaveBeenCalled()
  act(() =>
    buttons()
      .filter((b) => b.textContent === 'Copy image')
      .at(-1)!
      .click(),
  )
  expect(onCopy).toHaveBeenCalledOnce()
})

it('offers Save without Copy when browser image writes are unavailable', () => {
  vi.stubGlobal('navigator', {})
  render(COMPACT_PLATFORM)
  expect(buttons().map((b) => b.textContent)).toEqual(['Image', 'Save image'])
  act(() => buttons()[1]!.click())
  expect(onSave).toHaveBeenCalledOnce()
})

it.each([DESKTOP_PLATFORM, WIDE_BROWSER_PLATFORM])(
  'keeps right-click copy on expanded surfaces ($nativeImageClipboard)',
  (platform) => {
    render(platform)
    const trigger = container.querySelector('button')!
    expect(trigger.getAttribute('data-tooltip-description')).toBe('Right-click to copy')
    act(() => {
      trigger.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }))
    })
    expect(onCopy).toHaveBeenCalledOnce()
    expect(document.querySelector('[data-testid="context-menu-sheet"]')).toBeNull()
    if (platform.nativeImageClipboard) expect(buttons()).toHaveLength(1)
  },
)

it.each([COMPACT_PLATFORM, WIDE_BROWSER_PLATFORM])(
  'groups browser lightbox actions after the image in normal flow ($formFactor)',
  (platform) => {
    act(() =>
      root.render(
        <PlatformProvider value={platform}>
          <ImageLightboxFrame onCopy={onCopy} onSave={onSave}>
            <img alt="Full image" />
          </ImageLightboxFrame>
        </PlatformProvider>,
      ),
    )
    const image = container.querySelector('img')!
    const actions = container.querySelector('[role="group"][aria-label="Image actions"]')!
    expect(image.nextElementSibling).toBe(actions)
    expect(actions.className).not.toContain('absolute')
    expect(image.parentElement!.className).toContain('flex-col')
  },
)

it('keeps Desktop lightbox markup image-only', () => {
  act(() =>
    root.render(
      <PlatformProvider value={DESKTOP_PLATFORM}>
        <ImageLightboxFrame onCopy={onCopy} onSave={onSave}>
          <img alt="Full image" />
        </ImageLightboxFrame>
      </PlatformProvider>,
    ),
  )
  expect(container.children).toHaveLength(1)
  expect(container.firstElementChild?.tagName).toBe('IMG')
})
