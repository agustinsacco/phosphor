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
import { useMenuTriggers } from './ContextMenu'
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
  const open = vi.fn()
  const factory = vi.fn(() => items())
  let vibrate: ReturnType<typeof vi.fn>

  function Row({ disabled = false, title }: { disabled?: boolean; title?: string }) {
    const menu = useMenuTriggers(factory, { disabled, title })
    return (
      <button type="button" data-testid="row" {...menu} onClick={open}>
        Lane
      </button>
    )
  }
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
  function pointer(target: Element, type: string, pointerType = 'touch', x = 20, y = 30): boolean {
    let result = true
    act(() => {
      const event = new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        clientX: x,
        clientY: y,
      })
      Object.defineProperty(event, 'pointerType', { value: pointerType })
      result = target.dispatchEvent(event)
    })
    return result
  }
  const fire = (target: Element, type: string, init: MouseEventInit = {}): boolean => {
    let result = true
    act(() => {
      result = target.dispatchEvent(
        new MouseEvent(type, { bubbles: true, cancelable: true, ...init }),
      )
    })
    return result
  }
  const press = (target: Element, key: string, shiftKey = false): boolean => {
    let result = true
    act(() => {
      result = target.dispatchEvent(
        new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true }),
      )
    })
    return result
  }
  const advance = (ms: number): void => act(() => void vi.advanceTimersByTime(ms))
  const sheet = (): HTMLElement | null => document.querySelector('[role="dialog"]')
  /** The contract: a hold opens somewhere in 450-500ms. */
  const HOLD_MIN_MS = 450
  const HOLD_MS = 500

  beforeEach(() => {
    vi.useFakeTimers()
    open.mockClear()
    factory.mockClear()
    vibrate = vi.fn()
    Object.defineProperty(navigator, 'vibrate', { value: vibrate, configurable: true })
  })
  afterEach(() => {
    vi.useRealTimers()
    Reflect.deleteProperty(navigator, 'vibrate')
  })

  it('opens on a touch long-press at the press point, vibrates once and swallows the click', () => {
    const row = mount(<Row />)
    expect(row.getAttribute('data-menu-trigger')).toBe('true')
    pointer(row, 'pointerdown')
    advance(HOLD_MIN_MS - 1)
    expect(menu()).toBeNull()
    advance(HOLD_MS - HOLD_MIN_MS + 1)
    expect(menu()!.style.left).toBe('20px')
    expect(menu()!.style.top).toBe('30px')
    expect(vibrate).toHaveBeenCalledTimes(1)
    expect(vibrate).toHaveBeenCalledWith(10)
    pointer(row, 'pointerup')
    expect(fire(row, 'click')).toBe(false)
    expect(open).not.toHaveBeenCalled()
    pointer(row, 'pointerdown')
    pointer(row, 'pointerup')
    fire(row, 'click')
    expect(open).toHaveBeenCalledTimes(1)
  })

  it('opens on a pen long-press too, and never on a mouse hold', () => {
    const row = mount(<Row />)
    pointer(row, 'pointerdown', 'mouse')
    advance(2000)
    expect(menu()).toBeNull()
    pointer(row, 'pointerup', 'mouse')
    fire(row, 'click')
    expect(open).toHaveBeenCalledTimes(1)
    pointer(row, 'pointerdown', 'pen')
    advance(HOLD_MS)
    expect(menu()).not.toBeNull()
    expect(vibrate).toHaveBeenCalledTimes(1)
  })

  it('cancels the hold on movement past ten pixels, pointercancel, release or scroll', () => {
    const row = mount(<Row />)
    pointer(row, 'pointerdown')
    pointer(row, 'pointermove', 'touch', 26, 36)
    advance(HOLD_MS)
    expect(menu()).not.toBeNull()
    act(() => void window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))

    for (const interrupt of [
      () => pointer(row, 'pointermove', 'touch', 20, 41),
      () => pointer(row, 'pointercancel'),
      () => pointer(row, 'pointerup'),
      () => act(() => void document.dispatchEvent(new Event('scroll'))),
    ]) {
      pointer(row, 'pointerdown')
      interrupt()
      advance(HOLD_MS * 2)
      expect(menu()).toBeNull()
    }
    expect(vibrate).toHaveBeenCalledTimes(1)
    expect(factory).toHaveBeenCalledTimes(1)
  })

  it("dedupes Android's native contextmenu, whichever comes first", () => {
    const row = mount(<Row />)
    pointer(row, 'pointerdown')
    advance(HOLD_MS)
    expect(fire(row, 'contextmenu', { clientX: 90, clientY: 90 })).toBe(false)
    expect(menu()!.style.left).toBe('20px')

    pointer(row, 'pointerdown')
    advance(HOLD_MIN_MS - 100)
    expect(fire(row, 'contextmenu', { clientX: 60, clientY: 70 })).toBe(false)
    expect(menu()!.style.left).toBe('60px')
    advance(500)
    expect(menu()!.style.left).toBe('60px')
    pointer(row, 'pointerup')
    expect(fire(row, 'click')).toBe(false)

    expect(factory).toHaveBeenCalledTimes(2)
    expect(vibrate).toHaveBeenCalledTimes(2)
    expect(open).not.toHaveBeenCalled()
  })

  it('opens at the pointer on right-click, without vibrating', () => {
    const row = mount(<Row />)
    pointer(row, 'pointerdown', 'mouse', 70, 80)
    expect(fire(row, 'contextmenu', { clientX: 70, clientY: 80 })).toBe(false)
    expect(menu()!.style.left).toBe('70px')
    expect(menu()!.style.top).toBe('80px')
    expect(vibrate).not.toHaveBeenCalled()
  })

  it('opens below the element on the ContextMenu key and Shift+F10, ignoring other keys', () => {
    const row = mount(<Row />)
    vi.spyOn(row, 'getBoundingClientRect').mockReturnValue({ left: 12, bottom: 40 } as DOMRect)
    expect(press(row, 'F10')).toBe(true)
    expect(press(row, 'Enter')).toBe(true)
    expect(menu()).toBeNull()
    expect(press(row, 'ContextMenu')).toBe(false)
    expect(menu()!.style.left).toBe('12px')
    expect(menu()!.style.top).toBe('44px')
    act(() => void window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
    expect(press(row, 'F10', true)).toBe(false)
    expect(menu()).not.toBeNull()
    expect(vibrate).not.toHaveBeenCalled()
  })

  it('lets a caller compose its own onKeyDown', () => {
    const own = vi.fn()
    function Composed() {
      const menu = useMenuTriggers(factory)
      return (
        <button
          type="button"
          data-testid="row"
          {...menu}
          onKeyDown={(event) => {
            menu.onKeyDown(event)
            if (!event.defaultPrevented) own(event.key)
          }}
        >
          Lane
        </button>
      )
    }
    const row = mount(<Composed />)
    press(row, 'Enter')
    press(row, 'ContextMenu')
    expect(own.mock.calls).toEqual([['Enter']])
    expect(menu()).not.toBeNull()
  })

  it('does nothing when disabled: events pass through, no menu, no vibration', () => {
    const row = mount(<Row disabled />)
    expect(fire(row, 'contextmenu')).toBe(true)
    expect(press(row, 'ContextMenu')).toBe(true)
    pointer(row, 'pointerdown')
    advance(HOLD_MS * 2)
    pointer(row, 'pointerup')
    expect(fire(row, 'click')).toBe(true)
    expect(menu()).toBeNull()
    expect(sheet()).toBeNull()
    expect(vibrate).not.toHaveBeenCalled()
    expect(open).toHaveBeenCalledTimes(1)
  })

  it('opens without haptics where there is no Vibration API, or it throws', () => {
    const row = mount(<Row />)
    Reflect.deleteProperty(navigator, 'vibrate')
    pointer(row, 'pointerdown')
    advance(HOLD_MS)
    expect(menu()).not.toBeNull()
    act(() => void window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
    Object.defineProperty(navigator, 'vibrate', {
      configurable: true,
      value: () => {
        throw new Error('refused')
      },
    })
    pointer(row, 'pointerdown')
    advance(HOLD_MS)
    expect(menu()).not.toBeNull()
  })

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

  it('shows a disabled row its reason as text on a phone', () => {
    mount(null, COMPACT_PLATFORM)
    act(() =>
      showContextMenuAt(0, 0, [
        { label: 'Delete', hint: 'another delete is running', disabled: true, onClick: vi.fn() },
      ]),
    )
    const row = sheet()!.querySelector('button')!
    expect(row.disabled).toBe(true)
    expect(row.querySelector('.action-sheet-hint')!.textContent).toBe('another delete is running')
  })

  it('closes the sheet on Escape and on a backdrop tap, returning focus to the trigger', () => {
    const row = mount(<Row title="Fix the build" />, COMPACT_PLATFORM)
    row.focus()
    press(row, 'ContextMenu')
    expect(sheet()!.contains(document.activeElement)).toBe(true)
    act(() => void window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })))
    expect(sheet()).toBeNull()
    expect(document.activeElement).toBe(row)

    press(row, 'ContextMenu')
    fire(document.querySelector('[data-modal-overlay]')!, 'click')
    expect(sheet()).toBeNull()
    expect(document.activeElement).toBe(row)
  })

  it('keeps the long-press trailing click off the sheet that opened under the finger', () => {
    const row = mount(<Row title="Fix the build" />, COMPACT_PLATFORM)
    pointer(row, 'pointerdown')
    advance(HOLD_MS)
    expect(vibrate).toHaveBeenCalledTimes(1)
    pointer(row, 'pointerup')
    const backdrop = document.querySelector('[data-modal-overlay]')!
    fire(backdrop, 'click')
    expect(sheet()).not.toBeNull()
    pointer(backdrop, 'pointerdown')
    fire(backdrop, 'click')
    expect(sheet()).toBeNull()
    expect(open).not.toHaveBeenCalled()
  })
})
