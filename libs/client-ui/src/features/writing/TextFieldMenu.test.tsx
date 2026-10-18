// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { PhosphorApi } from '@shared/ipc'
import { DEFAULT_WRITING_PREFS } from '@shared/writing'
import type { ContextMenuItem } from '@/components/ContextMenu'
import { useWritingStore } from '@/stores/writing'
import { TextFieldMenu } from './TextFieldMenu'

const shown = vi.hoisted(() => ({ items: null as ContextMenuItem[] | null }))
vi.mock('@/components/ContextMenu', () => ({
  showContextMenuAt: (_x: number, _y: number, items: ContextMenuItem[]) => {
    shown.items = items
  },
}))

// jsdom has no `spellcheck` property. Chromium's: true unless spellcheck="false".
if (!('spellcheck' in HTMLElement.prototype)) {
  Object.defineProperty(HTMLElement.prototype, 'spellcheck', {
    get(this: HTMLElement) {
      return this.getAttribute('spellcheck') !== 'false'
    },
  })
}

let root: Root | null = null
const invoke = vi.fn(async () => undefined)

beforeEach(() => {
  shown.items = null
  invoke.mockClear()
  window.phosphor = {
    platform: 'darwin',
    invoke,
    spellingSuggestions: (word: string) => (word === 'recieve' ? ['receive', 'relieve'] : null),
  } as unknown as PhosphorApi
  useWritingStore.setState({ prefs: DEFAULT_WRITING_PREFS })
  const container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => root!.render(<TextFieldMenu />))
})

afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.innerHTML = ''
  delete (window as { phosphor?: PhosphorApi }).phosphor
})

/** Put `html` in the page and return its first element. */
function mount<T extends HTMLElement>(html: string): T {
  const host = document.createElement('div')
  host.innerHTML = html
  document.body.appendChild(host)
  return host.querySelector<T>('textarea, input, div > *')!
}

function rightClick(target: Element): MouseEvent {
  const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
  target.dispatchEvent(event)
  return event
}

const labels = (): string[] | undefined => shown.items?.map((item) => item.label)

describe('TextFieldMenu', () => {
  it('opens on a text field with suggestions for the word at the caret', () => {
    const field = mount<HTMLTextAreaElement>('<textarea>please recieve it</textarea>')
    field.setSelectionRange(9, 9)
    expect(rightClick(field).defaultPrevented).toBe(true)
    expect(labels()).toEqual([
      'receive',
      'relieve',
      'Add to dictionary',
      'Cut',
      'Copy',
      'Paste',
      'Select all',
    ])
  })

  it('opens on a text input too', () => {
    rightClick(mount('<input type="text" value="hello" />'))
    expect(labels()).toContain('Paste')
  })

  it('stands aside when a component already opened its own menu', () => {
    const field = mount<HTMLTextAreaElement>('<textarea>text</textarea>')
    field.parentElement!.addEventListener('contextmenu', (event) => event.preventDefault())
    rightClick(field)
    expect(shown.items).toBeNull()
  })

  it.each([
    ['the terminal', '<div class="xterm"><textarea></textarea></div>'],
    ['the editor', '<div class="monaco-editor"><textarea></textarea></div>'],
    ['a password', '<input type="password" value="secret" />'],
    ['a disabled field', '<textarea disabled>text</textarea>'],
    ['a checkbox', '<input type="checkbox" />'],
    ['plain text', '<p>not a field</p>'],
  ])('leaves %s alone', (_label, html) => {
    const host = document.createElement('div')
    host.innerHTML = html
    document.body.appendChild(host)
    const event = rightClick(host.querySelector('textarea, input, p')!)
    expect(shown.items).toBeNull()
    expect(event.defaultPrevented).toBe(false)
  })

  it('offers no suggestions in a field that turns spellcheck off', () => {
    const field = mount<HTMLTextAreaElement>('<textarea spellcheck="false">recieve</textarea>')
    field.setSelectionRange(2, 2)
    rightClick(field)
    expect(labels()).toEqual(['Cut', 'Copy', 'Paste', 'Select all'])
  })

  it('offers no suggestions while Check spelling is off', () => {
    useWritingStore.setState({ prefs: { ...DEFAULT_WRITING_PREFS, spellcheck: false } })
    const field = mount<HTMLTextAreaElement>('<textarea>recieve</textarea>')
    field.setSelectionRange(2, 2)
    rightClick(field)
    expect(labels()).toEqual(['Cut', 'Copy', 'Paste', 'Select all'])
  })

  it('adds the word to the dictionary through main', () => {
    const field = mount<HTMLTextAreaElement>('<textarea>recieve</textarea>')
    field.setSelectionRange(2, 2)
    rightClick(field)
    shown.items!.find((item) => item.label === 'Add to dictionary')!.onClick()
    expect(invoke).toHaveBeenCalledWith('writing:learnWord', 'recieve')
  })

  it('gives the field back its focus and selection before an edit command', () => {
    const field = mount<HTMLTextAreaElement>('<textarea>hello world</textarea>')
    field.setSelectionRange(0, 5)
    rightClick(field)
    field.blur()
    field.setSelectionRange(11, 11)
    shown.items!.find((item) => item.label === 'Paste')!.onClick()
    expect(document.activeElement).toBe(field)
    expect([field.selectionStart, field.selectionEnd]).toEqual([0, 5])
    expect(invoke).toHaveBeenCalledWith('writing:edit', 'paste')
  })
})
