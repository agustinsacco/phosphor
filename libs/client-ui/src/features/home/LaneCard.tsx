import type { ReactNode } from 'react'
import { TooltipButton } from '@/components/Tooltip'

/** Shared card shell for local workbench lanes and Host snapshot lanes. */
export function LaneCard({
  title,
  status,
  detail,
  branch,
  onOpen,
  action,
  children,
}: {
  title: string
  status: ReactNode
  detail?: string
  branch: string | null | undefined
  onOpen: () => void
  action: ReactNode
  children?: ReactNode
}): React.JSX.Element {
  return (
    <article
      className="border-border bg-surface flex min-w-0 flex-col rounded-lg border p-4"
      data-testid="lane-board-card"
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2 font-mono text-xs">
        {status}
      </div>
      <h2>
        <TooltipButton
          onClick={onOpen}
          className="hover:text-accent line-clamp-2 text-left text-xl font-semibold"
          tooltip={title}
        >
          {title}
        </TooltipButton>
      </h2>
      {detail && <p className="text-text-secondary mt-1 text-base">{detail}</p>}
      {children}
      <div className="mt-auto flex items-center justify-between gap-3 pt-4">
        <span
          className="text-text-secondary min-w-0 truncate font-mono text-sm"
          data-tooltip={branch}
        >
          {branch ?? 'Workspace session'}
        </span>
        {action}
      </div>
    </article>
  )
}
