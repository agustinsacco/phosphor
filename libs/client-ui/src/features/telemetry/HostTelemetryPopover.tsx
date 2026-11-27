/**
 * The machine popover: what this Host is doing right now, and what Phosphor is
 * doing inside it.
 *
 * One scroll, no tabs — a snapshot you have to navigate stops being a snapshot.
 * Every number comes from the polled view in `stores/telemetry`; nothing here
 * asks the Host for anything, so opening it is free and the range control never
 * re-reads. The blocks themselves are `TelemetrySections`.
 */
import { useMemo, useState } from 'react'
import clsx from 'clsx'
import { PopupMenu } from '@/components/PopupMenu'
import { TooltipButton } from '@/components/Tooltip'
import { connectionLabel, machineLabel, useRemoteLanesStore } from '@/stores/remoteLanes'
import { hostFeatureRefusal } from '@/stores/hostRefusals'
import {
  TELEMETRY_POLL_MS,
  telemetryUnreadable,
  telemetryView,
  useTelemetry,
} from '@/stores/telemetry'
import { ringWindow } from '@/stores/telemetryModel'
import { Cores, Graph, Lanes, Memory, Phosphor, Summary } from './TelemetrySections'
import { UNREADABLE, rangeMs, sampledAgo, type RangeId } from './telemetryReadout'

/** Past three missed polls the sample on screen is a memory, not a measurement. */
export const STALE_SAMPLE_MS = TELEMETRY_POLL_MS * 3
export function HostTelemetryPopover({
  hostId,
  hostIds,
  onSelectHost,
  onClose,
  triggerRef,
}: {
  hostId: string
  /** Every machine this client can switch between. */
  hostIds: readonly string[]
  onSelectHost: (hostId: string) => void
  onClose: () => void
  triggerRef: React.RefObject<HTMLElement | null>
}): React.JSX.Element {
  const view = useTelemetry((state) => telemetryView(state, hostId))
  const unreadable = useTelemetry((state) => telemetryUnreadable(state, hostId))
  const host = useRemoteLanesStore((s) => s.hosts[hostId])
  const [range, setRange] = useState<RangeId>('1m')
  const window = useMemo(
    () => ringWindow(view.points, rangeMs(range), Date.now()),
    [view.points, range],
  )
  // Named, so the refusal says what is missing here rather than what it rides on.
  const refusal = hostFeatureRefusal(host, 'skills.read', 'machine telemetry')
  const ageMs = view.receivedAt === null ? null : Date.now() - view.receivedAt

  return (
    <PopupMenu
      onClose={onClose}
      triggerRef={triggerRef}
      fitViewport
      escapeContainer
      className="w-[min(460px,calc(100vw-2rem))] p-0"
      ariaLabel="Machine telemetry"
    >
      <div className="max-h-[min(70vh,620px)] overflow-y-auto">
        <header className="border-border flex items-center gap-1 border-b px-2.5 py-2">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
            {hostIds.map((id) => (
              <MachineTab
                key={id}
                hostId={id}
                active={id === hostId}
                onSelect={() => onSelectHost(id)}
              />
            ))}
          </div>
          <span className="text-text-tertiary shrink-0 font-mono text-2xs">
            {sampledAgo(ageMs, STALE_SAMPLE_MS)}
          </span>
        </header>

        {refusal !== undefined || unreadable ? (
          <p className="text-text-secondary px-3 py-3 text-sm">
            {refusal ?? 'This Host is too old to report its own resources.'}
          </p>
        ) : (
          <>
            <Summary view={view} lanes={host?.lanes ?? []} />
            <Graph window={window} range={range} onRange={setRange} />
            <Cores corePct={view.corePct} />
            <Memory view={view} />
            <Phosphor view={view} />
            <Lanes lanes={host?.lanes ?? []} />
          </>
        )}
      </div>
      <footer className="border-border text-text-tertiary flex items-center justify-between border-t px-3 py-1.5 font-mono text-2xs">
        <span>every {TELEMETRY_POLL_MS / 1000}s while open</span>
        <span>{host?.hostVersion ? `Host ${host.hostVersion}` : UNREADABLE}</span>
      </footer>
    </PopupMenu>
  )
}

/** One machine in the switcher: its name, and whether it is answering at all. */
function MachineTab({
  hostId,
  active,
  onSelect,
}: {
  hostId: string
  active: boolean
  onSelect: () => void
}): React.JSX.Element {
  const state = useRemoteLanesStore((s) => s.hosts[hostId]?.state)
  const ready = state === 'ready'
  return (
    <TooltipButton
      onClick={onSelect}
      tooltip={false}
      aria-pressed={active}
      className={clsx(
        'flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-xs transition-colors',
        active ? 'bg-bg-secondary text-text' : 'text-text-tertiary hover:bg-bg-secondary',
      )}
    >
      <span
        aria-hidden
        className={clsx(
          'h-1.5 w-1.5 shrink-0 rounded-full',
          ready
            ? 'bg-success'
            : state === 'down' || state === 'no-address'
              ? 'bg-danger'
              : 'bg-warning',
        )}
      />
      {machineLabel(hostId)}
      {!ready && <span className="text-text-tertiary">{connectionLabel(state)}</span>}
    </TooltipButton>
  )
}
