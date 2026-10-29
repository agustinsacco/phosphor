import { useEffect, useRef } from 'react'
import clsx from 'clsx'
import { ModalOverlay } from '@/components/Modal'
import { TooltipButton } from '@/components/Tooltip'

/**
 * A phone's menu: a dialog that rises from the bottom edge, with a grab bar and
 * an optional head. Backdrop tap and Escape close it (ModalOverlay). Focus moves
 * to the current row, else the first enabled one, and goes back on close.
 */
export function ActionSheet({
  label,
  head,
  returnFocus,
  onClose,
  children,
}: {
  /** The dialog's accessible name. */
  label: string
  head?: React.ReactNode
  /** Where focus returns on close; by default, whatever had it when the sheet opened. */
  returnFocus?: HTMLElement | null
  onClose: () => void
  children: React.ReactNode
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const returnTo = useRef(returnFocus ?? document.activeElement)
  useEffect(() => {
    const sheet = ref.current
    const first =
      sheet?.querySelector<HTMLElement>('[aria-current="page"]:not(:disabled)') ??
      sheet?.querySelector<HTMLElement>('button:not(:disabled)')
    first?.focus()
    const previous = returnTo.current
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus()
    }
  }, [])
  return (
    <ModalOverlay onClose={onClose} backdrop="dim">
      <div ref={ref} role="dialog" aria-modal="true" aria-label={label} className="action-sheet">
        <div className="action-sheet-grab" aria-hidden />
        {head && <div className="action-sheet-head">{head}</div>}
        {children}
      </div>
    </ModalOverlay>
  )
}

/** One sheet row. A hint is visible text under the label: phones have no tooltips. */
export function ActionSheetItem({
  icon,
  current = false,
  danger = false,
  disabled = false,
  hint,
  onClick,
  children,
}: {
  icon?: React.ReactNode
  current?: boolean
  danger?: boolean
  disabled?: boolean
  /** A qualifier, or why the row is disabled; shown under the label. */
  hint?: string
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <TooltipButton
      tooltip={false}
      className={clsx('action-sheet-item', danger && 'action-sheet-danger')}
      aria-current={current ? 'page' : undefined}
      disabled={disabled}
      onClick={onClick}
    >
      {icon && <span className="action-sheet-icon">{icon}</span>}
      <span className="min-w-0">
        <span className="block truncate">{children}</span>
        {hint && <span className="action-sheet-hint">{hint}</span>}
      </span>
    </TooltipButton>
  )
}
