import { describe, expect, it } from 'vitest'
import { clipboardActionFor, type ClipboardKeyEvent } from './clipboardKeys'

function key(overrides: Partial<ClipboardKeyEvent>): ClipboardKeyEvent {
  return {
    type: 'keydown',
    code: 'KeyC',
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    ...overrides,
  }
}

describe('clipboardActionFor', () => {
  it('maps Ctrl+Shift+C/V on linux and windows', () => {
    const copy = key({ code: 'KeyC', ctrlKey: true, shiftKey: true })
    const paste = key({ code: 'KeyV', ctrlKey: true, shiftKey: true })
    expect(clipboardActionFor(copy, 'linux')).toBe('copy')
    expect(clipboardActionFor(paste, 'linux')).toBe('paste')
    expect(clipboardActionFor(copy, 'win32')).toBe('copy')
    expect(clipboardActionFor(paste, 'win32')).toBe('paste')
  })

  it('leaves plain Ctrl+C alone so it still reaches the shell as SIGINT', () => {
    expect(clipboardActionFor(key({ ctrlKey: true }), 'linux')).toBeNull()
  })

  it('maps Cmd+C/V on macOS, and not Ctrl+Shift+C', () => {
    expect(clipboardActionFor(key({ metaKey: true }), 'darwin')).toBe('copy')
    expect(clipboardActionFor(key({ code: 'KeyV', metaKey: true }), 'darwin')).toBe('paste')
    expect(clipboardActionFor(key({ ctrlKey: true, shiftKey: true }), 'darwin')).toBeNull()
  })

  it('ignores keyup, other keys, and chords with extra modifiers', () => {
    expect(clipboardActionFor(key({ type: 'keyup', ctrlKey: true, shiftKey: true }), 'linux')).toBe(
      null,
    )
    expect(clipboardActionFor(key({ code: 'KeyF', ctrlKey: true, shiftKey: true }), 'linux')).toBe(
      null,
    )
    expect(
      clipboardActionFor(key({ ctrlKey: true, shiftKey: true, altKey: true }), 'linux'),
    ).toBeNull()
    expect(clipboardActionFor(key({ metaKey: true, shiftKey: true }), 'darwin')).toBeNull()
  })
})
