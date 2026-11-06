import { TooltipButton } from '@/components/Tooltip'
import clsx from 'clsx'

/**
 * A square icon button for a pane's header row, labelled by its `title`.
 *
 * `pressed` makes it an on/off toggle and `expanded` a disclosure for the part
 * of the pane it shows; each is announced as such and lit in the accent colour
 * while on. A plain action passes neither; `disabled` dims it.
 */
export function IconToggle({
  title,
  pressed,
  expanded,
  disabled,
  onClick,
  children,
}: {
  title: string
  pressed?: boolean
  expanded?: boolean
  disabled?: boolean
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <TooltipButton
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={pressed}
      aria-expanded={expanded}
      disabled={disabled}
      onClick={onClick}
      className={clsx(
        'flex h-6 w-6 items-center justify-center rounded-sm transition-colors disabled:opacity-40',
        pressed || expanded
          ? 'text-accent bg-accent-soft'
          : 'text-text-tertiary hover:text-text hover:bg-bg-secondary',
      )}
    >
      {children}
    </TooltipButton>
  )
}
