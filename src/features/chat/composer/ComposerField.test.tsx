// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, useRef, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ComposerField } from './ComposerField'

// jsdom has no ResizeObserver and the autogrow hook installs one on mount.
globalThis.ResizeObserver ??= class {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
} as unknown as typeof ResizeObserver

let root: Root | null = null
let container: HTMLDivElement | null = null

function render(ui: React.ReactNode): void {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root!.render(ui)
  })
}

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  root = null
  container = null
  document.body.innerHTML = ''
})

function Harness({
  initial = '',
  onSubmit = () => {},
  onKeyDown,
}: {
  initial?: string
  onSubmit?: () => void
  onKeyDown?: (event: React.KeyboardEvent<HTMLTextAreaElement>) => boolean
}): React.JSX.Element {
  const [value, setValue] = useState(initial)
  const ref = useRef<HTMLTextAreaElement>(null)
  return (
    <ComposerField
      value={value}
      textareaRef={ref}
      onChange={setValue}
      onSubmit={onSubmit}
      onKeyDown={onKeyDown}
      onPasteFiles={() => {}}
      placeholder="type here"
      data-testid="field"
    />
  )
}

function field(): HTMLTextAreaElement {
  return document.querySelector('[data-testid="field"]') as HTMLTextAreaElement
}

/** Put the caret where a real user would have it before pressing a key. */
function caretAt(index: number): void {
  const el = field()
  el.setSelectionRange(index, index)
}

function press(
  key: string,
  init: Partial<KeyboardEventInit> & { code?: string } = {},
): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
  act(() => {
    field().dispatchEvent(event)
  })
  return event
}

describe('ComposerField', () => {
  it('sends on Enter', () => {
    const onSubmit = vi.fn()
    render(<Harness initial="hello" onSubmit={onSubmit} />)
    caretAt(5)
    press('Enter')
    expect(onSubmit).toHaveBeenCalledOnce()
    expect(field().value).toBe('hello')
  })

  it('still sends on Enter when the line is a list item', () => {
    const onSubmit = vi.fn()
    render(<Harness initial="- fix the bug" onSubmit={onSubmit} />)
    caretAt(13)
    press('Enter')
    expect(onSubmit).toHaveBeenCalledOnce()
    expect(field().value).toBe('- fix the bug')
  })

  it('continues the list on ⇧Enter', () => {
    const onSubmit = vi.fn()
    render(<Harness initial="- one" onSubmit={onSubmit} />)
    caretAt(5)
    press('Enter', { shiftKey: true })
    expect(onSubmit).not.toHaveBeenCalled()
    expect(field().value).toBe('- one\n- ')
    expect(field().selectionStart).toBe(8)
  })

  it('renumbers as an ordered list grows', () => {
    render(<Harness initial="1. one" />)
    caretAt(6)
    press('Enter', { shiftKey: true })
    expect(field().value).toBe('1. one\n2. ')
  })

  it('leaves ⇧Enter alone outside a list', () => {
    render(<Harness initial="prose" />)
    caretAt(5)
    press('Enter', { shiftKey: true })
    // The browser inserts the newline; the field must not have swallowed it.
    expect(field().value).toBe('prose')
  })

  it('exits the list on ⇧Enter from an empty item', () => {
    render(<Harness initial={'- one\n- '} />)
    caretAt(8)
    press('Enter', { shiftKey: true })
    expect(field().value).toBe('- one\n')
  })

  it('indents with Tab inside a list and outdents with ⇧Tab', () => {
    render(<Harness initial={'- one\n- two'} />)
    caretAt(11)
    press('Tab')
    expect(field().value).toBe('- one\n  - two')
    press('Tab', { shiftKey: true })
    expect(field().value).toBe('- one\n- two')
  })

  it('leaves Tab alone outside a list', () => {
    render(<Harness initial="prose" />)
    caretAt(5)
    press('Tab')
    expect(field().value).toBe('prose')
  })

  it('toggles a bullet list with the mod-shift-8 chord', () => {
    render(<Harness initial="one" />)
    act(() => field().setSelectionRange(0, 3))
    press('*', { code: 'Digit8', metaKey: true, shiftKey: true })
    expect(field().value).toBe('- one')
  })

  it('toggles a numbered list with the mod-shift-7 chord', () => {
    render(<Harness initial="one" />)
    act(() => field().setSelectionRange(0, 3))
    press('&', { code: 'Digit7', metaKey: true, shiftKey: true })
    expect(field().value).toBe('1. one')
  })

  it('bolds the selection with mod-B', () => {
    render(<Harness initial="make me bold" />)
    act(() => field().setSelectionRange(8, 12))
    press('b', { code: 'KeyB', metaKey: true })
    expect(field().value).toBe('make me **bold**')
  })

  it('leaves selected list text to the browser on Shift+Enter', () => {
    render(<Harness initial="- selected" />)
    act(() => field().setSelectionRange(2, 10))
    expect(press('Enter', { shiftKey: true }).defaultPrevented).toBe(false)
    expect(field().value).toBe('- selected')
  })

  it('does not send or invoke popup/history keys during composition', () => {
    const onSubmit = vi.fn()
    const onKeyDown = vi.fn(() => false)
    render(<Harness initial="漢字" onSubmit={onSubmit} onKeyDown={onKeyDown} />)
    act(() => {
      field().dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
    })
    for (const key of ['Enter', 'Tab', 'Escape', 'ArrowUp']) press(key)
    press('b', { code: 'KeyB', metaKey: true })
    expect(onKeyDown).not.toHaveBeenCalled()
    expect(onSubmit).not.toHaveBeenCalled()
    expect(field().value).toBe('漢字')
    act(() => {
      field().dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))
    })
    press('Enter')
    expect(onSubmit).toHaveBeenCalledOnce()
  })

  it('also guards native isComposing and legacy keyCode 229 without composition events', () => {
    const onSubmit = vi.fn()
    render(<Harness initial="候補" onSubmit={onSubmit} />)
    press('Enter', { isComposing: true })
    press('Enter', { keyCode: 229 })
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('lets the caller consume a key before the keymap sees it', () => {
    const onSubmit = vi.fn()
    const onKeyDown = vi.fn(() => true)
    render(<Harness initial="hello" onSubmit={onSubmit} onKeyDown={onKeyDown} />)
    caretAt(5)
    press('Enter')
    expect(onKeyDown).toHaveBeenCalledOnce()
    expect(onSubmit).not.toHaveBeenCalled()
  })
})
