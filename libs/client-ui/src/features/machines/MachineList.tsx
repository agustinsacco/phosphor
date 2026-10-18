import { usePlatform } from '@/platform/Platform'
import clsx from 'clsx'
import { machineStatus, type MachineView } from '@shared/control-api'
import { TooltipButton, tooltipProps } from '@/components/Tooltip'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { useSessionsStore } from '@/stores/sessions'
import { localChecks, type Computer } from './LocalMachine'
import { machineHeadline } from './machineReachability'
import {
  LOCAL_MACHINE,
  localMachineLabel,
  platformName,
  readinessChecks,
  readinessFreshness,
  relativeTime,
  sortMachines,
} from './machinePresentation'
import { Skeleton, Spinner, StatusDot, StatusPill } from './MachineUi'

const ROW =
  'hover:bg-bg-secondary focus-visible:bg-bg-secondary focus-visible:outline-accent grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 px-4 py-2.5 text-left transition-colors md:grid-cols-[minmax(0,1fr)_auto_auto]'

/** A fixed status column, so readiness dots line up from row to row. */
const STATUS = 'flex w-44 shrink-0 items-center justify-end gap-3'

/** Three tiny indicators instead of a wall of chips: green, or amber with the reason. */
function ReadinessDots({
  checks,
}: {
  checks: { name: string; ok: boolean; short: string; loading?: boolean }[]
}): React.JSX.Element {
  return (
    <span className="hidden items-center gap-3 md:flex">
      {checks.map((check) => (
        <span
          key={check.name}
          data-check-chip={check.name}
          data-ok={check.ok}
          {...tooltipProps(check.loading ? `Checking ${check.name}…` : check.short)}
          className={clsx(
            'inline-flex items-center gap-1.5 text-sm',
            check.ok || check.loading ? 'text-text-secondary' : 'text-warning font-medium',
          )}
        >
          {check.loading ? <Spinner size={9} /> : <StatusDot tone={check.ok ? 'ok' : 'warn'} />}
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

export function LocalMachineRow({
  computer,
  onOpen,
}: {
  computer: Computer
  onOpen: () => void
}): React.JSX.Element {
  const liveHere = useSessionsStore((s) => Object.keys(s.live).length)
  const label = localMachineLabel(window.phosphor.platform)
  const checks = localChecks(computer)
  const loading = checks.some((check) => check.loading)
  const problems = checks.filter((check) => !check.ok && !check.loading)
  return (
    <TooltipButton
      tooltip={`Open ${label}`}
      data-testid="local-machine-row"
      className={ROW}
      onClick={onOpen}
    >
      <span className="min-w-0">
        <span className="block truncate text-lg font-medium">{label}</span>
        <span className="text-text-tertiary block truncate text-sm">
          {platformName(window.phosphor.platform)}
          {computer.health?.ok ? ` · pi ${computer.health.version}` : ''}
          {liveHere ? ` · ${liveHere} live ${liveHere === 1 ? 'lane' : 'lanes'}` : ''}
        </span>
      </span>
      <ReadinessDots checks={checks} />
      <span className={STATUS}>
        {loading ? (
          <StatusPill tone="pending">Checking…</StatusPill>
        ) : problems.length ? (
          <StatusPill tone="warn" hint={problems.map((p) => p.short).join(' · ')}>
            {problems.length === 1
              ? (problems[0]?.short ?? 'Needs attention')
              : `${problems.length} issues`}
          </StatusPill>
        ) : (
          <StatusPill tone="ok">Ready</StatusPill>
        )}
        <Chevron />
      </span>
    </TooltipButton>
  )
}

export function MachineRow({
  machine,
  now,
  offset,
  onOpen,
}: {
  machine: MachineView
  now: number
  offset: number
  onOpen: () => void
}): React.JSX.Element {
  const connection = useRemoteLanesStore((s) => s.hosts[machine.id])
  const corrected = now + offset
  const headline = machineHeadline(machine, connection, corrected)
  const live = readinessFreshness(machine, now, offset) === 'live'
  const checks = readinessChecks(machine.readiness, machine.endpoint)
  // Counts come with each heartbeat; an offline machine's are history.
  const lanes = live ? machine.lanes : null
  const meta = [
    machine.hostname !== machine.label ? machine.hostname : null,
    `${platformName(machine.platform)} ${machine.arch}`,
    connection?.hostVersion || machine.hostVersion
      ? `Host ${connection?.hostVersion || machine.hostVersion}`
      : null,
    lanes && (lanes.running > 0 || lanes.waiting > 0)
      ? `${lanes.running} running · ${lanes.waiting} waiting`
      : null,
    machine.lastSeenAt && headline.tone !== 'ok'
      ? `last seen ${relativeTime(machine.lastSeenAt, corrected)}`
      : null,
  ].filter(Boolean)
  return (
    <TooltipButton
      tooltip={`Open ${machine.label}`}
      data-testid="enrolled-machine-row"
      data-status={machineStatus(machine, now, offset)}
      className={ROW}
      onClick={onOpen}
    >
      <span className="min-w-0">
        <span className="block truncate text-lg font-medium">{machine.label}</span>
        <span className="text-text-tertiary block truncate text-sm">{meta.join(' · ')}</span>
      </span>
      {live ? <ReadinessDots checks={checks} /> : <span className="hidden md:block" />}
      <span className={STATUS}>
        <StatusPill tone={headline.tone} hint={headline.detail}>
          {headline.label}
        </StatusPill>
        <Chevron />
      </span>
    </TooltipButton>
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
  computer,
  signedIn,
  machines,
  loading,
  now,
  offset,
  onOpen,
  empty,
}: {
  computer: Computer
  signedIn: boolean
  machines: readonly MachineView[]
  loading: boolean
  now: number
  offset: number
  onOpen: (id: string) => void
  /** Shown under the Hosts group when there is nothing to list. */
  empty: React.ReactNode
}): React.JSX.Element {
  const { localLanes } = usePlatform()
  const sorted = sortMachines(machines, now, offset)
  const firstLoad = signedIn && loading && machines.length === 0
  return (
    <div className="space-y-6">
      {localLanes && (
        <Group title="This computer">
          <LocalMachineRow computer={computer} onOpen={() => onOpen(LOCAL_MACHINE)} />
        </Group>
      )}
      {signedIn && (machines.length > 0 || firstLoad) ? (
        <Group
          title={machines.length ? `Hosts · ${machines.length}` : 'Hosts'}
          aside={
            loading && machines.length > 0 ? (
              <span className="text-text-tertiary flex items-center gap-1.5 text-sm">
                <Spinner size={10} /> Updating
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
                machine={machine}
                now={now}
                offset={offset}
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
