// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useSessionsStore } from '@/stores/sessions'
import { SessionList } from './SessionList'

let root: Root
let container: HTMLDivElement

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  useSessionsStore.setState({ sessionOrder: [], setSessionOrder: vi.fn() })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const items = ['/a', '/b'].map((path) => ({
  id: path,
  path,
  content: <button type="button">{path}</button>,
}))

function pointerDown(target: Element, pointerType: string): void {
  // jsdom has no PointerEvent constructor; React reads `pointerType` off the event.
  const event = new MouseEvent('pointerdown', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'pointerType', { value: pointerType })
  target.dispatchEvent(event)
}

function dragStart(target: Element): boolean {
  const event = new Event('dragstart', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', {
    value: { setData: vi.fn(), effectAllowed: 'none' },
  })
  target.dispatchEvent(event)
  return !event.defaultPrevented
}

it('starts a drag from a mouse, never from a touch or pen long-press, which opens the menu', () => {
  act(() => root.render(<SessionList items={items} />))
  const row = container.querySelector<HTMLElement>('[data-session-path="/a"]')!
  const button = row.querySelector('button')!
  for (const pointer of ['touch', 'pen']) {
    act(() => pointerDown(button, pointer))
    expect(row.draggable).toBe(false)
    expect(dragStart(button)).toBe(false)
  }
  act(() => pointerDown(button, 'mouse'))
  expect(row.draggable).toBe(true)
  expect(dragStart(button)).toBe(true)
})

it('keeps Alt+arrow reordering after a touch', () => {
  act(() => root.render(<SessionList items={items} />))
  const button = container.querySelector('[data-session-path="/a"] button')!
  act(() => pointerDown(button, 'touch'))
  act(() => {
    button.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true }),
    )
  })
  expect(useSessionsStore.getState().setSessionOrder).toHaveBeenCalledWith(['/b', '/a'])
})
