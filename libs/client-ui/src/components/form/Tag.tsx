import clsx from 'clsx'
import type { HTMLAttributes } from 'react'

/** A small rounded label chip. `className` gives its colours; the default is secondary. */
export function Tag({ className, ...props }: HTMLAttributes<HTMLSpanElement>): React.JSX.Element {
  return (
    <span
      {...props}
      className={clsx(
        'shrink-0 whitespace-nowrap rounded-full px-1.5 py-0.5 text-2xs font-medium',
        className ?? 'bg-bg-secondary text-text-secondary',
      )}
    />
  )
}
