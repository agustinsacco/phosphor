import { useEffect, useId, useRef, useState } from 'react'
import clsx from 'clsx'
import { CloseIcon } from '@/components/icons'
import { ModalOverlay } from '@/components/Modal'
import { PopupMenu } from '@/components/PopupMenu'
import { TooltipButton } from '@/components/Tooltip'
import { CHIP } from '@/components/form'
import './laneHeaderPill.css'

/** Closes the popup; focus returns to the pill unless the action moved it elsewhere. */
export type ClosePill = (restoreFocus?: boolean) => void

interface LaneHeaderPillProps {
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
  /** A full-height bottom sheet with this title, for a phone. */
  sheet?: { title: string }
  children: (close: ClosePill) => React.ReactNode
}

/**
 * A lane header quick link: a real tab stop that opens an anchored details
 * popup. The PR status and Slack threads pills are both this; their contents
 * differ, their focus and dismissal must not.
 *
 * It draws the bar's shared `CHIP` shape rather than its own, so a pull
 * request reads as the same kind of label as the workspace and branch chips to
 * its left. `className` is the whole of its theme: the PR pill passes its
 * verdict tone, the Slack pill the neutral chip ground. The `border` stays
 * because a tone carries part of its meaning in its edge, which the flat
 * ground those neighbours use has no need of.
 *
 * Enter/Space opens and focus starts on the popup's `data-popup-autofocus`
 * element, else its first button; Escape, an
 * outside click or the pill itself closes it and returns focus to the pill.
 *
 * `sheet` is the phone shell's choice: the details fill a bottom sheet the
 * height of the screen, with its own Close, instead of an anchored popup.
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
  sheet,
  children,
}: LaneHeaderPillProps): React.JSX.Element {
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
          // On touch it keeps its drawn size and gains a 44px hit area.
          'hit-slop border focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent',
          CHIP,
          className,
        )}
      >
        {face}
      </TooltipButton>
      {open && sheet && (
        <PillSheet id={id} region={region} title={sheet.title} close={close}>
          {children(close)}
        </PillSheet>
      )}
      {open && !sheet && (
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

/** The details as a phone's bottom sheet: the height of the screen, its title and Close. */
function PillSheet({
  id,
  region,
  title,
  close,
  children,
}: {
  id: string
  region: string
  title: string
  close: ClosePill
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <ModalOverlay onClose={close} backdrop="dim">
      <div id={id} role="dialog" aria-modal="true" aria-label={region} className="lane-pill-sheet">
        <div className="lane-pill-sheet-bar">
          <strong>{title}</strong>
          <TooltipButton type="button" aria-label="Close" onClick={() => close()}>
            <CloseIcon size={16} />
          </TooltipButton>
        </div>
        <FocusFirst className="lane-pill-sheet-body">{children}</FocusFirst>
      </div>
    </ModalOverlay>
  )
}

/** `region` names the popup's contents; a sheet's dialog already carries the name. */
function FocusFirst({
  region,
  className,
  children,
}: {
  region?: string
  className?: string
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
    <div ref={ref} role={region ? 'region' : undefined} aria-label={region} className={className}>
      {children}
    </div>
  )
}
