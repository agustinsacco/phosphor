import { useEffect, useRef, useState } from 'react'

/**
 * Anchored popup list used by the command menu, @-mentions and pickers.
 * Handles outside-click dismissal and keeps the active row scrolled into view.
 *
 * `triggerRef` is what makes a click-toggled menu closeable. Without it the
 * trigger button counts as "outside": mousedown closes the menu, then the
 * button's own click re-opens it, so the menu never appears to close. Every
 * click-toggled caller must pass the ref of the element that toggles it.
 * (Menus opened by typing — `/`, `@` — have no trigger and can omit it.)
 */
export function PopupMenu({
  children,
  onClose,
  className,
  triggerRef,
  fitViewport = false,
  role,
  id,
  ariaLabel,
  ariaActiveDescendant,
}: {
  children: React.ReactNode
  onClose: () => void
  className?: string
  triggerRef?: React.RefObject<HTMLElement | null>
  fitViewport?: boolean
  /**
   * `listbox` for a typeahead list whose rows are `MenuRow role="option"`.
   * Pair with `ariaActiveDescendant` so a screen reader follows the ↑/↓
   * highlight, which lives on the rows and never moves DOM focus off the
   * textarea.
   */
  role?: 'listbox'
  id?: string
  ariaLabel?: string
  ariaActiveDescendant?: string
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [computedStyle, setComputedStyle] = useState<React.CSSProperties>({})

  useEffect(() => {
    if (!fitViewport || !ref.current) {
      setComputedStyle({})
      return
    }
    // Apply a viewport-safe max-width so the popup never overflows past the
    // viewport right edge regardless of left/right alignment.
    setComputedStyle({ maxWidth: 'calc(100vw - 2rem)' })
  }, [fitViewport])

  useEffect(() => {
    const handler = (event: MouseEvent): void => {
      const target = event.target as Node
      if (ref.current?.contains(target)) return
      // The trigger toggles on click; letting mousedown close here first would
      // make that click a re-open.
      if (triggerRef?.current?.contains(target)) return
      onClose()
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('mousedown', handler)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('mousedown', handler)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [onClose, triggerRef])

  return (
    <div
      ref={ref}
      style={computedStyle}
      // Marks the subtree as no-drag (see .titlebar-drag in styles/index.css):
      // a menu opened from inside a window-drag region must stay clickable,
      // including its non-button rows (labels, separators).
      data-popup-menu
      role={role}
      id={id}
      aria-label={ariaLabel}
      aria-activedescendant={ariaActiveDescendant}
      className={`border-border bg-surface-raised z-30 overflow-hidden rounded-lg border shadow-lg ${className ?? ''}`}
    >
      {children}
    </div>
  )
}

export function MenuRow({
  active,
  disabled,
  onClick,
  onHover,
  title,
  trailing,
  testId,
  id,
  role,
  ariaSelected,
  children,
}: {
  active: boolean
  /** `option` inside a `PopupMenu role="listbox"`; the id is what its `aria-activedescendant` names. */
  id?: string
  role?: 'option'
  ariaSelected?: boolean
  /**
   * Renders the row inert: no click, no hover highlight, dimmed. Callers must
   * also skip disabled rows in their own ↑/↓ handling — this only stops the
   * pointer.
   */
  disabled?: boolean
  onClick: () => void
  onHover?: () => void
  title?: string
  /**
   * A secondary control for the row (the model picker's pin toggle).
   *
   * It renders as a SIBLING overlaying the row's right edge, never as a child:
   * the row itself is a `<button>`, and a nested button is invalid HTML that
   * browsers recover from by hoisting it out — which silently breaks both
   * controls. The row gets extra right padding so its content clears it.
   */
  trailing?: React.ReactNode
  /** `data-testid` on the row button, so a suite can select rows and not their controls. */
  testId?: string
  children: React.ReactNode
}): React.JSX.Element {
  const ref = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ block: 'nearest' })
  }, [active])

  const row = (
    <button
      ref={ref}
      id={id}
      role={role}
      aria-selected={ariaSelected}
      onMouseMove={disabled ? undefined : onHover}
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      title={title}
      data-testid={testId}
      className={`flex w-full items-center gap-2.5 py-1 pl-3 text-left text-lg transition-colors ${
        trailing ? 'pr-9' : 'pr-3'
      } ${
        disabled
          ? 'cursor-not-allowed opacity-45'
          : `cursor-pointer ${active ? 'bg-bg-secondary' : 'hover:bg-bg-secondary'}`
      }`}
    >
      {children}
    </button>
  )

  if (!trailing) return row
  return (
    // `group/row` lets a trailing control fade in on row hover — it is a
    // sibling of the row, so it cannot use the row's own :hover.
    <div className="group/row relative">
      {row}
      <span className="absolute right-1.5 top-1/2 flex -translate-y-1/2 items-center">
        {trailing}
      </span>
    </div>
  )
}
