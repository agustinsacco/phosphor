import clsx from 'clsx'
import { CheckIcon, ReloadIcon, WarningIcon } from '@/components/icons'
import { tooltipProps } from '@/components/Tooltip'
import { CopyCommand } from './MachineControls'
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
    <span
      {...tooltipProps(hint)}
      data-tone={tone}
      className={clsx(
        'inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-sm font-medium',
        PILL[tone],
      )}
    >
      <StatusDot tone={tone} pulse={tone === 'pending'} />
      {children}
    </span>
  )
}

/** A bordered section with a mono eyebrow, the page's unit of grouping. */
export function Card({
  title,
  aside,
  children,
  className,
  label,
}: {
  title: string
  aside?: React.ReactNode
  children: React.ReactNode
  className?: string
  /** Accessible name when it differs from the title. */
  label?: string
}): React.JSX.Element {
  return (
    <section
      aria-label={label ?? title}
      className={clsx('bg-surface border-border rounded-lg border', className)}
    >
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

export function Spinner({ size = 12, label }: { size?: number; label?: string }) {
  return (
    <span role={label ? 'status' : undefined} aria-label={label} className="inline-flex">
      <ReloadIcon size={size} className="text-text-tertiary motion-safe:animate-spin" />
    </span>
  )
}

export interface CheckItem {
  name: string
  ok: boolean
  short: string
  detail: string
  command?: string
  /** Still being read; shows a spinner instead of a verdict. */
  loading?: boolean
  /** What the row says while loading, when not "Checking…". */
  loadingText?: string
  /** Not applicable or not reported: neither passing nor failing. */
  muted?: boolean
}

/** The row already names the check: "Claude Code signed out" reads as "Signed out". */
export function checkState(check: CheckItem): string {
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
export function CheckRow({ check }: { check: CheckItem }): React.JSX.Element {
  const failing = !check.ok && !check.loading && !check.muted
  return (
    <div data-check={check.name} data-ok={check.ok} className="py-1.5">
      <div className="flex items-center gap-2.5">
        <span className="flex w-4 shrink-0 justify-center">
          {check.loading ? (
            <Spinner />
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

/** Label and value pairs for the Details card. */
export function Facts({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-2 text-base">{children}</dl>
  )
}
export function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-text-tertiary">{label}</dt>
      <dd className="min-w-0 truncate">{children}</dd>
    </>
  )
}
