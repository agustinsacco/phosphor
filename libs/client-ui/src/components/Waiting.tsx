import clsx from 'clsx'
import type { ReactNode } from 'react'
import { Spinner } from './icons'
import { PhosphorLoader } from './PhosphorLoader'

/**
 * One line saying what a screen is waiting for. A spinner, so it never reads as
 * a final state: "Reconnecting" in plain text looked the same as "down".
 */
export function WaitingNote({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}): React.JSX.Element {
  return (
    <p
      role="status"
      className={clsx('text-text-secondary flex items-center gap-2 text-sm', className)}
    >
      <Spinner />
      <span>{children}</span>
    </p>
  )
}

/** A whole pane waiting on its machine, with the beacon Desktop opens lanes with. */
export function WaitingPane({ title, detail }: { title: string; detail?: string }) {
  return (
    <div
      role="status"
      aria-busy="true"
      className="flex h-full min-h-60 flex-col items-center justify-center gap-3 p-6 text-center"
    >
      <PhosphorLoader decorative />
      <h1 className="text-text text-lg font-medium">{title}</h1>
      {detail && <p className="text-text-tertiary max-w-sm text-base">{detail}</p>}
    </div>
  )
}
