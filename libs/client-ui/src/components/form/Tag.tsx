import clsx from 'clsx'
import type { HTMLAttributes } from 'react'

const TAG_SIZES = {
  /** Badges beside a value: setting sources, read-only marks. */
  xs: 'px-1.5 py-0.5 text-2xs',
  /** Status chips with a dot: a machine's connection, a provider's state. */
  sm: 'inline-flex items-center gap-1.5 px-2 py-0.5 text-sm',
} as const

/** A small rounded label chip. `className` gives its colours; the default is secondary. */
export function Tag({
  className,
  size = 'xs',
  ...props
}: HTMLAttributes<HTMLSpanElement> & { size?: keyof typeof TAG_SIZES }): React.JSX.Element {
  return (
    <span
      {...props}
      className={clsx(
        'shrink-0 whitespace-nowrap rounded-full font-medium',
        TAG_SIZES[size],
        className ?? 'bg-bg-secondary text-text-secondary',
      )}
    />
  )
}
