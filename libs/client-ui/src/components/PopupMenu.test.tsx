// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest'
import { act, useRef, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { PopupMenu } from './PopupMenu'

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

/** A click-toggled menu — the shape every real caller uses. */
function Harness({ withTriggerRef }: { withTriggerRef: boolean }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  return (
    <div>
      <button ref={triggerRef} data-testid="trigger" onClick={() => setOpen((o) => !o)}>
        toggle
      </button>
      <span data-testid="outside">outside</span>
      {open && (
        <PopupMenu
          onClose={() => setOpen(false)}
          triggerRef={withTriggerRef ? triggerRef : undefined}
        >
          <div data-testid="menu">menu body</div>
        </PopupMenu>
      )}
    </div>
  )
}

const q = (id: string): HTMLElement | null => document.querySelector(`[data-testid="${id}"]`)

/** The real pointer sequence: mousedown lands before click. */
function clickLikeAUser(element: HTMLElement): void {
  act(() => {
    element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }))
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

describe('PopupMenu', () => {
  it('closes when the trigger is clicked a second time', () => {
    // The regression: mousedown closed the menu and the trigger's own click
    // immediately re-opened it, so it never appeared to close.
    render(<Harness withTriggerRef />)
    clickLikeAUser(q('trigger')!)
    expect(q('menu')).not.toBeNull()

    clickLikeAUser(q('trigger')!)
    expect(q('menu')).toBeNull()
  })

  it('reproduces the bug when no triggerRef is passed', () => {
    // Guards the fix itself: without the ref, the second click reopens.
    render(<Harness withTriggerRef={false} />)
    clickLikeAUser(q('trigger')!)
    clickLikeAUser(q('trigger')!)
    expect(q('menu')).not.toBeNull()
  })

  it('closes on an outside mousedown', () => {
    render(<Harness withTriggerRef />)
    clickLikeAUser(q('trigger')!)
    act(() => {
      q('outside')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    })
    expect(q('menu')).toBeNull()
  })

  it('stays open when clicking inside the menu', () => {
    render(<Harness withTriggerRef />)
    clickLikeAUser(q('trigger')!)
    act(() => {
      q('menu')!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    })
    expect(q('menu')).not.toBeNull()
  })

  it('closes on Escape', () => {
    render(<Harness withTriggerRef />)
    clickLikeAUser(q('trigger')!)
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(q('menu')).toBeNull()
  })
})
