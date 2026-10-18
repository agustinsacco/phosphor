// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { recordTextareaEdit } from './textareaUndo'

afterEach(() => {
  document.body.replaceChildren()
  Reflect.deleteProperty(document, 'execCommand')
})

it.each([
  ['before hello after', 'before **hello** after'],
  ['x😀!', 'x𯘀!'],
  ['', '🧠'],
  ['- item', ''],
])('records a plain-text replacement without splitting characters: %s', (before, after) => {
  const el = document.createElement('textarea')
  el.value = before
  document.body.append(el)
  const exec = vi.fn((command: string, _ui: boolean, text: string) => {
    expect(command).toBe('insertText')
    expect(document.activeElement).toBe(el)
    for (const index of [el.selectionStart, el.selectionEnd]) {
      expect(el.value[index] ?? '').not.toMatch(/[\uDC00-\uDFFF]/)
    }
    el.setRangeText(text, el.selectionStart, el.selectionEnd, 'end')
    return true
  })
  Object.defineProperty(document, 'execCommand', { configurable: true, value: exec })
  recordTextareaEdit(el, after)
  expect(exec).toHaveBeenCalledOnce()
  expect(el.value).toBe(after)
})

it('leaves unsupported harnesses and no-op edits to the controlled caller', () => {
  const el = document.createElement('textarea')
  el.value = 'draft'
  recordTextareaEdit(el, 'new')
  expect(el.value).toBe('draft')
  const exec = vi.fn(() => {
    throw new Error('unsupported')
  })
  Object.defineProperty(document, 'execCommand', { configurable: true, value: exec })
  recordTextareaEdit(el, 'draft')
  expect(exec).not.toHaveBeenCalled()
  expect(() => recordTextareaEdit(el, 'new')).not.toThrow()
})
