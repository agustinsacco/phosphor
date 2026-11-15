import clsx from 'clsx'
import { TooltipButton } from '@/components/Tooltip'
import { initials } from './prActivity'

/** Small bordered tag: "required", a workflow name, "code owner", "outdated". */
export function Tag({ children, strong = false }: { children: React.ReactNode; strong?: boolean }) {
  return (
    <span
      className={clsx(
        'border-border-strong shrink-0 whitespace-nowrap rounded border px-1 text-xs leading-4',
        strong ? 'text-text-secondary' : 'text-text-tertiary',
      )}
    >
      {children}
    </span>
  )
}

/** A hand-off or open button. `primary` drafts for the agent. */
export function ActionButton({
  primary = false,
  onClick,
  children,
  tooltip,
}: {
  primary?: boolean
  onClick: () => void
  children: React.ReactNode
  tooltip?: string
}): React.JSX.Element {
  return (
    <TooltipButton
      type="button"
      onClick={onClick}
      tooltip={tooltip}
      className={clsx(
        'focus-visible:outline-accent flex h-6 shrink-0 items-center gap-1 whitespace-nowrap rounded-md border px-2 text-base focus-visible:outline focus-visible:outline-2',
        primary
          ? 'bg-accent-soft border-accent/45 text-accent hover:border-accent'
          : 'bg-bg-secondary border-border-strong text-text hover:border-text-tertiary',
      )}
    >
      {children}
    </TooltipButton>
  )
}

/** An inline text link that is a button: "details", "log ↗", "+12 passing". */
export function LinkButton({
  onClick,
  children,
  expanded,
  label,
}: {
  onClick: () => void
  children: React.ReactNode
  expanded?: boolean
  label?: string
}): React.JSX.Element {
  return (
    <TooltipButton
      type="button"
      onClick={onClick}
      aria-expanded={expanded}
      aria-label={label}
      className="text-text-secondary hover:text-accent focus-visible:outline-accent shrink-0 whitespace-nowrap rounded-sm text-sm hover:underline focus-visible:outline focus-visible:outline-2"
    >
      {children}
    </TooltipButton>
  )
}

/** Initials in a ring: success approved, warning requested changes; a team is square. */
export function Avatar({
  name,
  ring = 'plain',
  team = false,
}: {
  name: string
  ring?: 'ok' | 'warn' | 'plain'
  team?: boolean
}): React.JSX.Element {
  return (
    <span
      aria-hidden="true"
      className={clsx(
        'bg-bg-secondary text-text-secondary grid size-5 shrink-0 place-items-center border-[1.5px] font-mono text-2xs font-bold',
        team ? 'rounded-[5px]' : 'rounded-full',
        ring === 'ok'
          ? 'border-success'
          : ring === 'warn'
            ? 'border-warning'
            : 'border-border-strong',
      )}
    >
      {initials(name)}
    </span>
  )
}

/** Placeholder rows the size of real ones, so a load never collapses the layout. */
export function SkeletonRows({ rows = 3 }: { rows?: number }): React.JSX.Element {
  return (
    <div aria-hidden="true" className="space-y-2 py-1">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton h-4" style={{ width: `${85 - i * 15}%` }} />
      ))}
    </div>
  )
}
