// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { NumberField, Row } from './fields'

let root: Root
let container: HTMLDivElement
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

function type(input: HTMLInputElement, value: string): void {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function renderReserve(onChange: (value: number) => void): HTMLInputElement {
  act(() =>
    root.render(
      <Row title="Reserve tokens">
        <NumberField value={16384} min={1024} max={131072} step={1024} onChange={onChange} />
      </Row>,
    ),
  )
  return container.querySelector('input')!
}

it('typing a partial number never saves a clamped value', () => {
  const onChange = vi.fn()
  const input = renderReserve(onChange)
  input.focus()
  type(input, '2')
  type(input, '20')
  type(input, '20480')
  expect(onChange).not.toHaveBeenCalled()
  expect(input.value).toBe('20480')
  act(() => input.blur())
  expect(onChange).toHaveBeenCalledExactlyOnceWith(20480)
})

it('commits on Enter and clamps only the committed value', () => {
  const onChange = vi.fn()
  const input = renderReserve(onChange)
  input.focus()
  type(input, '2')
  act(() => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })
  expect(onChange).toHaveBeenCalledExactlyOnceWith(1024)
  expect(input.value).toBe('1024')
})

it('restores the saved value when the field is left empty or unchanged', () => {
  const onChange = vi.fn()
  const input = renderReserve(onChange)
  input.focus()
  type(input, '')
  act(() => input.blur())
  expect(onChange).not.toHaveBeenCalled()
  expect(input.value).toBe('16384')
})

it('takes its accessible name from its Row', () => {
  const input = renderReserve(() => undefined)
  expect(input.getAttribute('aria-label')).toBe('Reserve tokens')
})
