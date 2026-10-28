// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import {
  ContextMenuHost,
  showContextMenuAt,
  showMenuBelow,
  type ContextMenuItem,
} from './ContextMenu'
import { COMPACT_PLATFORM, DESKTOP_PLATFORM, PlatformProvider } from '@/platform/Platform'

let root: Root
let container: HTMLDivElement
beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  act(() => root.render(<ContextMenuHost />))
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

const menu = (): HTMLElement | null => document.querySelector('[data-testid="context-menu"]')
const rows = (): HTMLButtonElement[] => Array.from(menu()?.querySelectorAll('button') ?? [])

function items(run = vi.fn()): ContextMenuItem[] {
  return [
    { label: 'Open', onClick: run },
    { label: 'Suspend', hint: '~200 MB', shortcut: '⌘S', onClick: vi.fn() },
    { label: 'Fork', separatorAbove: true, disabled: true, onClick: vi.fn() },
    { label: 'Delete', hint: 'to trash', danger: true, onClick: vi.fn() },
  ]
}

describe('ContextMenuHost expanded popover (characterization)', () => {
  it('renders every row with its hint, shortcut, separator, disabled and danger treatment', () => {
    act(() => showContextMenuAt(40, 50, items()))
    const popover = menu()!
    expect(popover.parentElement).toBe(document.body)
    expect(popover.style.left).toBe('40px')
    expect(popover.style.top).toBe('50px')
    expect(rows().map((row) => row.textContent)).toEqual([
      'Open',
      'Suspend~200 MB⌘S',
      'Fork',
      'Deleteto trash',
    ])
    expect(rows()[1]!.getAttribute('data-tooltip-description')).toBe('~200 MB')
    expect(rows()[2]!.disabled).toBe(true)
    expect(rows()[2]!.parentElement!.firstElementChild!.className).toContain('border-t')
    expect(popover.querySelectorAll('.border-t')).toHaveLength(1)
    expect(rows()[3]!.className).toContain('text-danger')
    expect(rows()[0]!.className).not.toContain('text-danger')
  })

  it('clamps its own box inside the window, eight pixels from each edge', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 200,
      height: 120,
    } as DOMRect)
    act(() => showContextMenuAt(window.innerWidth - 10, window.innerHeight - 10, items()))
    expect(menu()!.style.left).toBe(`${window.innerWidth - 208}px`)
    expect(menu()!.style.top).toBe(`${window.innerHeight - 128}px`)
    act(() => showContextMenuAt(-50, 2, items()))
    expect(menu()!.style.left).toBe('8px')
    expect(menu()!.style.top).toBe('8px')
  })

  it('drops below an anchor', () => {
    const anchor = document.createElement('button')
    vi.spyOn(anchor, 'getBoundingClientRect').mockReturnValue({ left: 30, bottom: 60 } as DOMRect)
    act(() => showMenuBelow(anchor, items()))
    expect(menu()!.style.left).toBe('30px')
    expect(menu()!.style.top).toBe('64px')
  })

  it('runs a clicked row and closes', () => {
    const run = vi.fn()
    act(() => showContextMenuAt(10, 10, items(run)))
    act(() => rows()[0]!.click())
    expect(run).toHaveBeenCalledTimes(1)
    expect(menu()).toBeNull()
  })

  it('closes on Escape, an outside mousedown and window blur, but not an inside mousedown', () => {
    act(() => showContextMenuAt(10, 10, items()))
    act(() => void rows()[0]!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })))
    expect(menu()).not.toBeNull()
    act(() => void window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
    expect(menu()).toBeNull()

    act(() => showContextMenuAt(10, 10, items()))
    act(() => void container.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })))
    expect(menu()).toBeNull()

    act(() => showContextMenuAt(10, 10, items()))
    act(() => void window.dispatchEvent(new Event('blur')))
    expect(menu()).toBeNull()
  })
})

describe('useMenuTriggers and the phone action sheet (regression: no long-press menu)', () => {
  function mount(node: React.ReactNode, platform = DESKTOP_PLATFORM): HTMLButtonElement {
    act(() =>
      root.render(
        <PlatformProvider value={platform}>
          <ContextMenuHost />
          {node}
        </PlatformProvider>,
      ),
    )
    return document.querySelector<HTMLButtonElement>('[data-testid="row"]')!
  }
  const sheet = (): HTMLElement | null => document.querySelector('[role="dialog"]')

  it('renders an action sheet on a phone: title, visible hints, disabled, danger, groups, Cancel', () => {
    mount(null, COMPACT_PLATFORM)
    const run = vi.fn()
    act(() => showContextMenuAt(5, 5, items(run), { title: 'Fix the build' }))
    expect(menu()).toBeNull()
    const dialog = sheet()!
    expect(dialog.getAttribute('aria-label')).toBe('Fix the build')
    expect(dialog.querySelector('.action-sheet-head')!.textContent).toBe('Fix the build')
    const groups = Array.from(dialog.querySelectorAll('[role="group"]'))
    expect(groups.map((group) => group.querySelectorAll('button').length)).toEqual([2, 2])
    const buttons = Array.from(dialog.querySelectorAll('button'))
    expect(buttons.map((button) => button.textContent)).toEqual([
      'Open',
      'Suspend~200 MB',
      'Fork',
      'Deleteto trash',
      'Cancel',
    ])
    expect(buttons[1]!.querySelector('.action-sheet-hint')!.textContent).toBe('~200 MB')
    expect(buttons[2]!.disabled).toBe(true)
    expect(buttons[3]!.className).toContain('action-sheet-danger')
    act(() => buttons[0]!.click())
    expect(run).toHaveBeenCalledTimes(1)
    expect(sheet()).toBeNull()

    act(() => showContextMenuAt(5, 5, items()))
    act(() => Array.from(sheet()!.querySelectorAll('button')).at(-1)!.click())
    expect(sheet()).toBeNull()
  })
})
