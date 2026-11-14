import { useEffect, useId, useRef, useState } from 'react'
import clsx from 'clsx'
import { PopupMenu } from '@/components/PopupMenu'
import { TooltipButton } from '@/components/Tooltip'

/** Closes the popup; focus returns to the pill unless the action moved it elsewhere. */
export type ClosePill = (restoreFocus?: boolean) => void

/**
 * A lane header quick link: a real tab stop that opens an anchored details
 * popup. The PR status and Slack threads pills are both this; their contents
 * differ, their focus and dismissal must not.
 *
 * Enter/Space opens and focus starts on the popup's `data-popup-autofocus`
 * element, else its first button; Escape, an
 * outside click or the pill itself closes it and returns focus to the pill.
 */
export function LaneHeaderPill({
  label,
  testId,
  variant,
  className,
  face,
  region,
  popupClassName = 'w-80 py-2',
  open: controlledOpen,
  onOpenChange,
  holdOpen,
  children,
}: {
  label: string
  testId: string
  variant?: string
  /** Colour classes for the pill's state. */
  className: string
  face: React.ReactNode
  /** Accessible name of the popup's region. */
  region: string
  /** Width and padding of the popup. */
  popupClassName?: string
  /** Controlled open state, for a pill something else can open. */
  open?: boolean
  onOpenChange?: (open: boolean) => void
  /** True while a dialog the popup opened is on top: clicks there must not close it. */
  holdOpen?: () => boolean
  children: (close: ClosePill) => React.ReactNode
}): React.JSX.Element {
  const [ownOpen, setOwnOpen] = useState(false)
  const open = controlledOpen ?? ownOpen
  const setOpen = (next: boolean): void => {
    setOwnOpen(next)
    onOpenChange?.(next)
  }
  const triggerRef = useRef<HTMLButtonElement>(null)
  const id = useId()
  const close: ClosePill = (restoreFocus = true) => {
    if (holdOpen?.()) return
    setOpen(false)
    if (restoreFocus) triggerRef.current?.focus()
  }
  return (
    <div className="titlebar-no-drag relative shrink-0">
      <TooltipButton
        ref={triggerRef}
        type="button"
        aria-label={label}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => (open ? close() : setOpen(true))}
        data-testid={testId}
        data-variant={variant}
        className={clsx(
          'flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-xs font-semibold focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent',
          className,
        )}
      >
        {face}
      </TooltipButton>
      {open && (
        <PopupMenu
          id={id}
          triggerRef={triggerRef}
          onClose={close}
          fitViewport
          escapeContainer
          className={`absolute left-0 top-full mt-1 ${popupClassName}`}
        >
          <FocusFirst region={region}>{children(close)}</FocusFirst>
        </PopupMenu>
      )}
    </div>
  )
}

function FocusFirst({
  region,
  children,
}: {
  region: string
  children: React.ReactNode
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    // The menu is fixed in the viewport by now; preventScroll keeps a later
    // regression there from dragging the whole window with it.
    const first =
      ref.current?.querySelector<HTMLElement>('[data-popup-autofocus]') ??
      ref.current?.querySelector('button')
    first?.focus({ preventScroll: true })
  }, [])
  return (
    <div ref={ref} role="region" aria-label={region}>
      {children}
    </div>
  )
}
