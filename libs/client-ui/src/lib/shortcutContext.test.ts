// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { ignoreShortcut, isComposerInput, shortcutOverlayOpen } from './shortcutContext'

afterEach(() => {
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

it('rejects consumed keys, native composition and AltGr', () => {
  for (const init of [{ isComposing: true }, { keyCode: 229 }, { altKey: true, ctrlKey: true }]) {
    expect(ignoreShortcut(new KeyboardEvent('keydown', init))).toBe(true)
  }
  const event = new KeyboardEvent('keydown', { cancelable: true })
  event.preventDefault()
  expect(ignoreShortcut(event)).toBe(true)
  expect(ignoreShortcut(new KeyboardEvent('keydown', { ctrlKey: true }))).toBe(false)
})

it('only exempts the palette itself, never another visible dialog', () => {
  vi.spyOn(HTMLElement.prototype, 'getClientRects').mockReturnValue({ length: 1 } as DOMRectList)
  document.body.innerHTML = '<div data-shortcut-overlay="palette"></div>'
  expect(shortcutOverlayOpen()).toBe(true)
  expect(shortcutOverlayOpen('palette')).toBe(false)
  for (const marker of ['data-modal-overlay', 'data-shortcut-overlay="finder"', 'role="dialog"']) {
    document.body.innerHTML = `<div data-shortcut-overlay="palette"></div><div ${marker}></div>`
    expect(shortcutOverlayOpen('palette')).toBe(true)
  }
})

it('ignores hidden editor widgets with dialog semantics', () => {
  document.body.innerHTML = '<div role="dialog" hidden></div>'
  expect(shortcutOverlayOpen()).toBe(false)
})

it('does not mistake an editor or another input for the composer', () => {
  const field = document.createElement('textarea')
  expect(isComposerInput(field)).toBe(false)
  field.dataset.composerInput = ''
  expect(isComposerInput(field)).toBe(true)
  expect(isComposerInput(null)).toBe(false)
})
