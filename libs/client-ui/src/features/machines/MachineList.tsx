import clsx from 'clsx'
import type { MachineView } from '@shared/control-api'
import { Spinner } from '@/components/icons'
import { TooltipButton, tooltipProps } from '@/components/Tooltip'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { hostSummary, type MachineSummary } from './machineOverview'
import { sortMachines, type ReadinessCheck } from './machinePresentation'
import { Skeleton, StatusDot, StatusPill } from './MachineUi'
import { MachineTasks } from './MachineTasks'

const ROW =
  'hover:bg-bg-secondary focus-visible:bg-bg-secondary focus-visible:outline-accent grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 px-4 py-2.5 text-left transition-colors md:grid-cols-[minmax(0,1fr)_auto_auto]'

/** A fixed status column, so readiness dots line up from row to row. */
const STATUS = 'flex w-44 shrink-0 items-center justify-end gap-3'

/**
 * Three tiny indicators instead of a wall of chips: green, or amber with the reason. A
 * narrow row puts them on their own line under the name rather than dropping them.
 */
function ReadinessDots({ checks }: { checks: ReadinessCheck[] }): React.JSX.Element {
  return (
    <span className="order-last col-span-full mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 md:order-none md:col-span-1 md:mt-0">
      {checks.map((check) => (
        <span
          key={check.name}
          data-check-chip={check.name}
          data-ok={check.ok}
          {...tooltipProps(check.loading ? `Checking ${check.name}…` : check.short)}
          className={clsx(
            'inline-flex items-center gap-1.5 text-sm',
            check.ok || check.loading || check.muted
              ? 'text-text-secondary'
              : 'text-warning font-medium',
          )}
        >
          {check.loading ? (
            <Spinner className="text-text-tertiary" />
          ) : (
            <StatusDot tone={check.ok ? 'ok' : check.muted ? 'off' : 'warn'} />
          )}
          {check.name === 'Claude Code' ? 'Claude' : check.name}
        </span>
      ))}
    </span>
  )
}

function Chevron(): React.JSX.Element {
  return (
    <span aria-hidden className="text-text-tertiary">
      ›
    </span>
  )
}

/** One row for any machine: name and facts, readiness dots, one status, then its running lanes. */
export function MachineRow({
  summary,
  onOpen,
}: {
  summary: MachineSummary
  onOpen: () => void
}): React.JSX.Element {
  const { label, headline, dots } = summary
  return (
    <div>
      <TooltipButton
        tooltip={`Open ${label}`}
        data-testid={summary.machine ? 'enrolled-machine-row' : 'local-machine-row'}
        data-status={summary.status}
        className={ROW}
        onClick={onOpen}
      >
        <span className="min-w-0">
          <span className="block truncate text-lg font-medium">{label}</span>
          <span className="text-text-tertiary block truncate text-sm">
            {summary.meta.join(' · ')}
          </span>
        </span>
        {dots ? <ReadinessDots checks={dots} /> : <span className="hidden md:block" />}
        <span className={STATUS}>
          <StatusPill tone={headline.tone} hint={headline.detail}>
            {headline.label}
          </StatusPill>
          <Chevron />
        </span>
      </TooltipButton>
      <MachineTasks machine={summary.id} tasks={summary.tasks} />
    </div>
  )
}

function Group({
  title,
  aside,
  children,
}: {
  title: string
  aside?: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section aria-label={title} className="space-y-2">
      <div className="flex items-center justify-between px-1">
        <h2 className="text-text-tertiary font-mono text-xs font-semibold uppercase tracking-wider">
          {title}
        </h2>
        {aside}
      </div>
      <div className="border-border divide-border bg-surface divide-y overflow-hidden rounded-lg border">
        {children}
      </div>
    </section>
  )
}

export function MachineList({
  local,
  signedIn,
  machines,
  loading,
  now,
  offset,
  onOpen,
  empty,
}: {
  local: MachineSummary | null
  signedIn: boolean
  machines: readonly MachineView[]
  loading: boolean
  now: number
  offset: number
  onOpen: (id: string) => void
  /** Shown under the Hosts group when there is nothing to list. */
  empty: React.ReactNode
}): React.JSX.Element {
  const hosts = useRemoteLanesStore((s) => s.hosts)
  const sorted = sortMachines(machines, now, offset)
  const firstLoad = signedIn && loading && machines.length === 0
  return (
    <div className="space-y-6">
      {local && (
        <Group title="This computer">
          <MachineRow summary={local} onOpen={() => onOpen(local.id)} />
        </Group>
      )}
      {signedIn && (machines.length > 0 || firstLoad) ? (
        <Group
          title={machines.length ? `Hosts · ${machines.length}` : 'Hosts'}
          aside={
            loading && machines.length > 0 ? (
              <span className="text-text-tertiary flex items-center gap-1.5 text-sm">
                <Spinner className="text-text-tertiary" /> Updating
              </span>
            ) : undefined
          }
        >
          {firstLoad ? (
            <div role="status" aria-label="Loading machines">
              {[0, 1, 2].map((row) => (
                <div key={row} className="flex items-center gap-4 px-4 py-3">
                  <span className="min-w-0 flex-1 space-y-2">
                    <Skeleton className="h-3.5 w-32" />
                    <Skeleton className="h-2.5 w-56" />
                  </span>
                  <Skeleton className="h-5 w-24 rounded-full" />
                </div>
              ))}
            </div>
          ) : (
            sorted.map((machine) => (
              <MachineRow
                key={machine.id}
                summary={hostSummary(machine, hosts[machine.id], now, offset)}
                onOpen={() => onOpen(machine.id)}
              />
            ))
          )}
        </Group>
      ) : (
        empty
      )}
    </div>
  )
}
