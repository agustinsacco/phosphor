// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createRef } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { ModalOverlay } from './Modal'
import { PopupMenu } from './PopupMenu'
import { TooltipButton, TooltipLabel, TooltipProvider, tooltipProps } from './Tooltip'

const { stopPositioning } = vi.hoisted(() => ({ stopPositioning: vi.fn() }))
vi.mock('@floating-ui/dom', () => ({
  autoUpdate: (_reference: unknown, _floating: unknown, update: () => void) => {
    update()
    return stopPositioning
  },
  computePosition: async () => ({ x: 20, y: 30 }),
  offset: vi.fn(),
  flip: vi.fn(),
  shift: vi.fn(),
}))

let root: Root
let container: HTMLDivElement
beforeEach(() => {
  vi.useFakeTimers()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.useRealTimers()
  vi.clearAllMocks()
})
function render(children: React.ReactNode): void {
  act(() => root.render(<TooltipProvider>{children}</TooltipProvider>))
}
const buttons = (): NodeListOf<HTMLButtonElement> => document.querySelectorAll('button')
const hint = (): HTMLElement | null => document.querySelector('[role="tooltip"]')
function pointer(
  target: Element,
  type = 'pointerover',
  relatedTarget: Element | null = null,
  pointerType = 'mouse',
): void {
  act(() => {
    const event = new MouseEvent(type, { bubbles: true, relatedTarget })
    Object.defineProperty(event, 'pointerType', { value: pointerType })
    target.dispatchEvent(event)
  })
}
async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}
function key(value: string): void {
  act(() =>
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }),
    ),
  )
}

describe('quiet tooltips', () => {
  it('waits the full delay on every target, never warming up neighboring controls', async () => {
    render(
      <>
        <TooltipButton>Save</TooltipButton>
        <TooltipButton>Cancel</TooltipButton>
      </>,
    )
    pointer(buttons()[0]!)
    await advance(649)
    expect(hint()).toBeNull()
    await advance(1)
    expect(hint()?.textContent).toBe('Save')
    pointer(buttons()[1]!)
    expect(hint()).toBeNull()
    await advance(649)
    expect(hint()).toBeNull()
    await advance(1)
    expect(hint()?.textContent).toBe('Cancel')
    expect(document.querySelectorAll('[role="tooltip"]')).toHaveLength(1)
    expect(container.contains(hint())).toBe(false)
  })

  it('never flashes when passing over a control or unmounting a pending target', async () => {
    render(<TooltipButton>Save</TooltipButton>)
    pointer(buttons()[0]!)
    await advance(200)
    pointer(buttons()[0]!, 'pointerout', document.body)
    await advance(700)
    expect(hint()).toBeNull()
    pointer(buttons()[0]!)
    render(null)
    await advance(700)
    expect(hint()).toBeNull()
  })

  it('is hoverable, persists while reading, and closes after leaving both regions', async () => {
    render(<TooltipButton>Save</TooltipButton>)
    const button = buttons()[0]!
    pointer(button)
    await advance(650)
    const bubble = hint()!
    // The bubble is separated from its trigger by a small physical gap.
    pointer(button, 'pointerout', document.body)
    pointer(document.body)
    await advance(50)
    pointer(bubble)
    await advance(5000)
    expect(hint()).toBe(bubble)
    pointer(bubble, 'pointerout', document.body)
    await advance(100)
    expect(hint()).toBeNull()
  })

  it('restarts a cancelled pending hover when returning through the close grace', async () => {
    render(<TooltipButton>Save</TooltipButton>)
    pointer(buttons()[0]!)
    await advance(200)
    pointer(buttons()[0]!, 'pointerout', document.body)
    await advance(50)
    pointer(buttons()[0]!)
    await advance(649)
    expect(hint()).toBeNull()
    await advance(1)
    expect(hint()?.textContent).toBe('Save')
  })

  it('cancels a pending hint on Escape without swallowing that Escape', async () => {
    const close = vi.fn()
    render(
      <ModalOverlay onClose={close}>
        <TooltipButton>Save</TooltipButton>
      </ModalOverlay>,
    )
    pointer(buttons()[0]!)
    key('Escape')
    expect(close).toHaveBeenCalledOnce()
    await advance(700)
    expect(hint()).toBeNull()
  })

  it('uses immediate keyboard focus, not click-induced or programmatic focus', async () => {
    render(<TooltipButton>Save</TooltipButton>)
    const button = buttons()[0]!
    act(() => button.focus())
    expect(hint()).toBeNull()
    act(() => button.blur())
    key('Tab')
    act(() => button.focus())
    expect(hint()?.textContent).toBe('Save')
    act(() => button.blur())
    pointer(button, 'pointerdown')
    act(() => button.focus())
    await advance(700)
    expect(hint()).toBeNull()
  })

  it.each(['click', 'scroll', 'blur', 'pointerdown'])(
    'dismisses on %s without reopening on child crossings',
    async (event) => {
      render(
        <TooltipButton>
          <span>Save</span>
        </TooltipButton>,
      )
      pointer(buttons()[0]!)
      await advance(650)
      act(() => window.dispatchEvent(new Event(event)))
      expect(hint()).toBeNull()
      pointer(buttons()[0]!.firstElementChild!)
      await advance(700)
      expect(hint()).toBeNull()
    },
  )

  it('never shows on touch or while a menu trigger is expanded', async () => {
    render(
      <TooltipButton aria-haspopup="menu" aria-expanded>
        Options
      </TooltipButton>,
    )
    pointer(buttons()[0]!)
    await advance(700)
    expect(hint()).toBeNull()
    render(<TooltipButton>Options</TooltipButton>)
    pointer(buttons()[0]!, 'pointerover', null, 'touch')
    await advance(700)
    expect(hint()).toBeNull()
  })

  it('allows hints on expanded disclosures, not just collapsed ones', async () => {
    render(<TooltipButton aria-expanded>Collapse folder</TooltipButton>)
    pointer(buttons()[0]!)
    await advance(650)
    expect(hint()?.textContent).toBe('Collapse folder')
  })

  it('dismisses the tooltip before its menu/modal or streaming Escape handler', async () => {
    const closeModal = vi.fn(),
      closeMenu = vi.fn(),
      abort = vi.fn()
    render(
      <ModalOverlay onClose={closeModal}>
        <PopupMenu onClose={closeMenu}>
          <TooltipButton>Save</TooltipButton>
        </PopupMenu>
      </ModalOverlay>,
    )
    window.addEventListener('keydown', abort)
    try {
      pointer(buttons()[0]!)
      await advance(650)
      key('Escape')
      expect(hint()).toBeNull()
      expect(closeModal).not.toHaveBeenCalled()
      expect(closeMenu).not.toHaveBeenCalled()
      expect(abort).not.toHaveBeenCalled()
      await advance(700)
      expect(hint()).toBeNull()
      key('Escape')
      expect(closeModal).toHaveBeenCalledOnce()
    } finally {
      window.removeEventListener('keydown', abort)
    }
  })

  it('keeps refs, events, accessible labels and existing descriptions without native titles', async () => {
    const ref = createRef<HTMLButtonElement>(),
      click = vi.fn()
    render(
      <TooltipButton
        ref={ref}
        onClick={click}
        aria-label="Save"
        aria-describedby="existing"
        title="Save source"
        tooltip={{ label: 'Save source', shortcut: ['mod', 'S'] }}
      >
        <svg />
      </TooltipButton>,
    )
    expect(ref.current).toBe(buttons()[0])
    expect(ref.current?.getAttribute('title')).toBeNull()
    expect(ref.current?.getAttribute('aria-label')).toBe('Save')
    pointer(buttons()[0]!)
    await advance(650)
    expect(hint()?.querySelector('kbd')?.textContent).toMatch(/S/)
    expect(ref.current?.getAttribute('aria-describedby')).toContain(hint()!.id)
    act(() => ref.current!.click())
    expect(click).toHaveBeenCalledOnce()
    expect(ref.current?.getAttribute('aria-describedby')).toBe('existing')
  })

  it('supports disabled native buttons and explicitly labelled checkbox controls', async () => {
    const click = vi.fn()
    render(
      <>
        <TooltipButton
          disabled
          onClick={click}
          tooltip={{ label: 'Run routine', description: 'Review unattended access first' }}
        >
          Run
        </TooltipButton>
        <TooltipLabel data-tooltip="Allow unattended access">
          <input type="checkbox" /> Allow
        </TooltipLabel>
      </>,
    )
    pointer(buttons()[0]!)
    await advance(650)
    expect(hint()?.textContent).toContain('Review unattended access first')
    act(() => buttons()[0]!.click())
    expect(click).not.toHaveBeenCalled()
    key('Tab')
    act(() => document.querySelector('input')!.focus())
    expect(hint()?.textContent).toBe('Allow unattended access')
  })

  it('uses the nearest explicit target and leaves unannotated/native third-party content alone', async () => {
    render(
      <div {...tooltipProps('Open lane')}>
        <TooltipButton aria-label="Close lane">
          <svg />
        </TooltipButton>
        <button title="Third-party hint">Other</button>
      </div>,
    )
    pointer(buttons()[0]!.querySelector('svg')!)
    await advance(650)
    expect(hint()?.textContent).toBe('Close lane')
    expect(buttons()[1]!.title).toBe('Third-party hint')
  })

  it('ignores unrelated scrolling, such as transcript autoscroll while streaming', async () => {
    render(
      <>
        <div data-testid="transcript" />
        <TooltipButton>Stop</TooltipButton>
      </>,
    )
    pointer(buttons()[0]!)
    await advance(300)
    act(() =>
      document.querySelector('[data-testid="transcript"]')!.dispatchEvent(new Event('scroll')),
    )
    await advance(350)
    expect(hint()?.textContent).toBe('Stop')
    act(() => document.dispatchEvent(new Event('scroll')))
    expect(hint()).toBeNull()
  })

  it('does not pop a hint when typing is followed by programmatic focus', () => {
    render(<TooltipButton>Save</TooltipButton>)
    key('Tab')
    key('a')
    act(() => buttons()[0]!.focus())
    expect(hint()).toBeNull()
  })

  it('caps labels derived from long visible content, never explicit ones', async () => {
    const long = 'word '.repeat(40).trim()
    render(
      <>
        <TooltipButton>{long}</TooltipButton>
        <TooltipButton tooltip={long}>x</TooltipButton>
      </>,
    )
    expect(buttons()[0]!.dataset.tooltip!.length).toBe(80)
    expect(buttons()[0]!.dataset.tooltip!.endsWith('…')).toBe(true)
    expect(buttons()[1]!.dataset.tooltip).toBe(long)
  })

  it('names a button from its title only when nothing visible names it', () => {
    function Glyph(): React.JSX.Element {
      return <span>Visible</span>
    }
    render(
      <>
        <TooltipButton title="Close pane">
          <svg />
        </TooltipButton>
        <TooltipButton title="Hint">
          <Glyph />
        </TooltipButton>
        <TooltipButton tooltip="Open image">
          <img alt="Attached image" />
        </TooltipButton>
      </>,
    )
    expect(buttons()[0]!.getAttribute('aria-label')).toBe('Close pane')
    expect(buttons()[1]!.getAttribute('aria-label')).toBeNull()
    expect(buttons()[2]!.getAttribute('aria-label')).toBeNull()
  })

  it('gives icon-only structured hints an accessible name', () => {
    render(
      <TooltipButton tooltip={{ label: 'Close pane' }}>
        <svg />
      </TooltipButton>,
    )
    expect(buttons()[0]!.getAttribute('aria-label')).toBe('Close pane')
  })

  it('suppresses an open menu trigger and clears the marker on dismissal', async () => {
    const ref = createRef<HTMLButtonElement>()
    function View({ menu }: { menu: boolean }): React.JSX.Element {
      return (
        <>
          <TooltipButton ref={ref}>Options</TooltipButton>
          {menu && (
            <PopupMenu triggerRef={ref} onClose={() => {}}>
              Menu
            </PopupMenu>
          )}
        </>
      )
    }
    render(<View menu />)
    pointer(buttons()[0]!)
    await advance(700)
    expect(hint()).toBeNull()
    expect(ref.current!.dataset.tooltipOpen).toBe('true')
    render(<View menu={false} />)
    expect(ref.current!.dataset.tooltipOpen).toBeUndefined()
  })

  it('dismisses hints when a new modal obscures their trigger', async () => {
    render(<TooltipButton>Save</TooltipButton>)
    pointer(buttons()[0]!)
    await advance(650)
    await act(async () =>
      root.render(
        <TooltipProvider>
          <TooltipButton>Save</TooltipButton>
          <ModalOverlay onClose={() => {}}>New dialog</ModalOverlay>
        </TooltipProvider>,
      ),
    )
    expect(hint()).toBeNull()
  })

  it('cleans up when an open target changes identity or disappears', async () => {
    render(<TooltipButton title="First">Open</TooltipButton>)
    pointer(buttons()[0]!)
    await advance(650)
    await act(async () =>
      root.render(
        <TooltipProvider>
          <TooltipButton title="Second">Open</TooltipButton>
        </TooltipProvider>,
      ),
    )
    expect(hint()).toBeNull()
    pointer(buttons()[0]!, 'pointerout', document.body)
    await advance(100)
    pointer(buttons()[0]!)
    await advance(650)
    expect(hint()?.textContent).toBe('Second')
    await act(async () => root.render(<TooltipProvider>{null}</TooltipProvider>))
    expect(hint()).toBeNull()
    expect(stopPositioning).toHaveBeenCalledTimes(2)
  })
})
