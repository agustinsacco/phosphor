import clsx from 'clsx'
import { CheckIcon, Spinner, WarningIcon } from '@/components/icons'
import { tooltipProps } from '@/components/Tooltip'
import { Tag } from '@/components/form'
import { CopyCommand } from './MachineControls'
import type { ReadinessCheck } from './machinePresentation'
import type { Tone } from './machineReachability'

/** Shared pieces of the Machines pages: one status vocabulary, one card, one check row. */
const DOT: Record<Tone, string> = {
  ok: 'bg-success',
  warn: 'bg-warning',
  error: 'bg-danger',
  off: 'bg-text-tertiary',
  pending: 'bg-info',
}
const PILL: Record<Tone, string> = {
  ok: 'bg-success/10 text-success',
  warn: 'bg-warning/10 text-warning',
  error: 'bg-danger-soft text-danger',
  off: 'bg-chip text-text-secondary',
  pending: 'bg-info/10 text-info',
}

export function StatusDot({ tone, pulse = false }: { tone: Tone; pulse?: boolean }) {
  return (
    <span
      aria-hidden
      className={clsx(
        'h-2 w-2 shrink-0 rounded-full',
        DOT[tone],
        pulse && 'motion-safe:animate-pulse',
      )}
    />
  )
}

export function StatusPill({
  tone,
  children,
  hint,
}: {
  tone: Tone
  children: React.ReactNode
  hint?: string
}): React.JSX.Element {
  return (
    <Tag {...tooltipProps(hint)} data-tone={tone} size="sm" className={PILL[tone]}>
      <StatusDot tone={tone} pulse={tone === 'pending'} />
      {children}
    </Tag>
  )
}

/** A bordered section with a mono eyebrow, the page's unit of grouping. */
export function Card({
  title,
  aside,
  children,
}: {
  title: string
  aside?: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section aria-label={title} className="bg-surface border-border rounded-lg border">
      <header className="border-border flex min-h-10 items-center justify-between gap-3 border-b px-4 py-2">
        <h3 className="text-text-tertiary font-mono text-xs font-semibold uppercase tracking-wider">
          {title}
        </h3>
        {aside && <div className="text-text-tertiary flex items-center gap-2 text-sm">{aside}</div>}
      </header>
      <div className="px-4 py-3">{children}</div>
    </section>
  )
}

/** A placeholder line while data is on its way. */
export function Skeleton({ className }: { className?: string }): React.JSX.Element {
  return (
    <span
      aria-hidden
      className={clsx('bg-chip block h-3 rounded motion-safe:animate-pulse', className)}
    />
  )
}

/** The row already names the check: "Claude Code signed out" reads as "Signed out". */
function checkState(check: ReadinessCheck): string {
  if (check.ok) return check.detail
  const rest = check.short.startsWith(`${check.name} `)
    ? check.short.slice(check.name.length + 1)
    : check.short
  return rest.charAt(0).toUpperCase() + rest.slice(1)
}

/**
 * One readiness line: verdict icon, name and its state in words. A failing
 * check opens to its explanation and the one command that fixes it.
 */
export function CheckRow({ check }: { check: ReadinessCheck }): React.JSX.Element {
  const failing = !check.ok && !check.loading && !check.muted
  return (
    <div data-check={check.name} data-ok={check.ok} className="py-1.5">
      <div className="flex items-center gap-2.5">
        <span className="flex w-4 shrink-0 justify-center">
          {check.loading ? (
            <Spinner className="text-text-tertiary" />
          ) : check.ok ? (
            <span aria-label="Passed">
              <CheckIcon size={13} className="text-success" />
            </span>
          ) : check.muted ? (
            <StatusDot tone="off" />
          ) : (
            <span aria-label="Needs attention">
              <WarningIcon size={13} className="text-warning" />
            </span>
          )}
        </span>
        <h4 className="text-lg min-w-0 flex-1 truncate font-medium">{check.name}</h4>
        <span
          {...tooltipProps(failing || check.ok ? undefined : check.detail)}
          className={clsx(
            'truncate text-base',
            failing ? 'text-warning font-medium' : 'text-text-secondary',
          )}
        >
          {check.loading ? (check.loadingText ?? 'Checking…') : checkState(check)}
        </span>
      </div>
      {failing && (
        <div className="mt-1.5 space-y-2 pl-[1.625rem]">
          <p className="text-text-secondary text-base">{check.detail}</p>
          {check.command && <CopyCommand command={check.command} />}
        </div>
      )}
    </div>
  )
}
