import type { HTMLAttributes } from 'react'
import clsx from 'clsx'
import './PageShell.css'

/** One content width and gutter for both shells. Fill lets lists/editors own their scroll. */
export function PageBody({
  children,
  className,
  layout = 'scroll',
  ...props
}: HTMLAttributes<HTMLDivElement> & {
  layout?: 'scroll' | 'fill'
}): React.JSX.Element {
  return (
    <div {...props} className={clsx('page-body', `page-body-${layout}`, className)}>
      <div className="page-body-content">{children}</div>
    </div>
  )
}
