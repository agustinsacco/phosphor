// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ContextMenuHost, showContextMenuAt, type ContextMenuItem } from './ContextMenu'
import { COMPACT_PLATFORM, DESKTOP_PLATFORM, PlatformProvider } from '@/platform/Platform'

let root: Root
let container: HTMLDivElement
const openPr = vi.fn()
const show = vi.fn()
const fallback = vi.fn()

function mount(platform = DESKTOP_PLATFORM): void {
  act(() =>
    root.render(
      <PlatformProvider value={platform}>
        <ContextMenuHost />
      </PlatformProvider>,
    ),
  )
}
beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  vi.clearAllMocks()
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const items = (): ContextMenuItem[] => [
  { label: 'Open', onClick: vi.fn() },
  {
    label: 'Pull requests',
    onClick: fallback,
    submenu: [
      { label: '#57 · Failing', onClick: () => openPr(57) },
      { label: 'Show pull requests…', separatorAbove: true, onClick: show },
    ],
  },
]
const menu = (): HTMLElement | null => document.querySelector('[data-testid="context-menu"]')
const submenu = (): HTMLElement | null => document.querySelector('[data-testid="context-submenu"]')
const button = (scope: ParentNode | null, text: string): HTMLButtonElement =>
  [...(scope?.querySelectorAll('button') ?? [])].find((b) => b.textContent?.startsWith(text))!
const key = (target: Element, name: string): void => {
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key: name, bubbles: true }))
  })
}

describe('a context menu submenu', () => {
  it('opens beside its row on click, runs a child and closes the whole menu', () => {
    mount()
    act(() => showContextMenuAt(10, 10, items()))
    const row = button(menu(), 'Pull requests')
    expect(row.getAttribute('aria-haspopup')).toBe('menu')
    expect(row.getAttribute('aria-expanded')).toBe('false')
    expect(submenu()).toBeNull()
    act(() => row.click())
    expect(row.getAttribute('aria-expanded')).toBe('true')
    expect([...submenu()!.querySelectorAll('button')].map((b) => b.textContent)).toEqual([
      '#57 · Failing',
      'Show pull requests…',
    ])
    act(() => button(submenu(), '#57').click())
    expect(openPr).toHaveBeenCalledWith(57)
    expect(fallback).not.toHaveBeenCalled()
    expect(menu()).toBeNull()
  })

  it('opens from the keyboard with focus inside, and steps back out with ArrowLeft or Escape', () => {
    mount()
    act(() => showContextMenuAt(10, 10, items()))
    const row = button(menu(), 'Pull requests')
    row.focus()
    key(row, 'ArrowRight')
    expect(document.activeElement?.textContent).toBe('#57 · Failing')
    key(document.activeElement!, 'ArrowLeft')
    expect(submenu()).toBeNull()
    expect(document.activeElement).toBe(row)
    key(row, 'ArrowRight')
    key(window as unknown as Element, 'Escape')
    expect(submenu()).toBeNull()
    expect(menu()).not.toBeNull()
    key(window as unknown as Element, 'Escape')
    expect(menu()).toBeNull()
  })

  it('closes when the pointer moves onto a plain row', () => {
    mount()
    act(() => showContextMenuAt(10, 10, items()))
    act(() => button(menu(), 'Pull requests').click())
    expect(submenu()).not.toBeNull()
    act(() => {
      button(menu(), 'Open').dispatchEvent(new PointerEvent('pointerover', { bubbles: true }))
    })
    expect(submenu()).toBeNull()
  })

  it('drills down in place on a phone sheet', () => {
    mount(COMPACT_PLATFORM)
    act(() => showContextMenuAt(5, 5, items(), { title: 'Lane' }))
    const sheet = (): HTMLElement => document.querySelector('[role="dialog"]')!
    act(() => button(sheet(), 'Pull requests').click())
    expect(sheet().querySelector('.action-sheet-head')!.textContent).toBe('Pull requests')
    expect([...sheet().querySelectorAll('button')].map((b) => b.textContent)).toEqual([
      '#57 · Failing',
      'Show pull requests…',
      'Cancel',
    ])
    act(() => button(sheet(), 'Show pull requests…').click())
    expect(show).toHaveBeenCalledOnce()
    expect(fallback).not.toHaveBeenCalled()
  })
})
