/**
 * The top bar's machine button: this Host's resources, in the slot the session
 * kebab used to hold.
 *
 * It reads the same polled store the popover does and shows the machine's load
 * while it is fresh, so a glance answers the question without opening anything.
 * Polling starts when the popover opens and stops when it closes or the tab hides
 * (`stores/telemetry` owns that), so a button sitting in the bar costs no reads.
 *
 * There is a button only where there is a Host to ask: This Mac's lanes while
 * Desktop runs them in-app have no Host connection to sample.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { TooltipButton } from '@/components/Tooltip'
import { MachinesIcon } from '@/components/icons'
import { machineLabel, useRemoteLanesStore } from '@/stores/remoteLanes'
import {
  setTelemetryAllowed,
  telemetryView,
  useTelemetry,
  watchTelemetry,
} from '@/stores/telemetry'
import { HostTelemetryPopover, STALE_SAMPLE_MS } from './HostTelemetryPopover'
import { formatPct } from './telemetryReadout'
import clsx from 'clsx'
import type { HostsSnapshot } from '@shared/ipc'

export function HostTelemetryButton(): React.JSX.Element | null {
  const hosts = useRemoteLanesStore((s) => s.hosts)
  const hostIds = useMemo(() => Object.keys(hosts), [hosts])
  const [chosen, setChosen] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const hostId = useMemo(() => preferredHost(hosts, chosen), [hosts, chosen])
  const view = useTelemetry((state) => telemetryView(state, hostId))

  useEffect(() => {
    if (!open || !hostId) return
    const stopWatching = watchTelemetry(hostId)
    const onVisibility = (): void => setTelemetryAllowed(document.visibilityState === 'visible')
    document.addEventListener('visibilitychange', onVisibility)
    onVisibility()
    return () => {
      stopWatching()
      document.removeEventListener('visibilitychange', onVisibility)
      // The next open is watched from the start, whoever was allowed before.
      setTelemetryAllowed(true)
    }
  }, [open, hostId])

  if (!hostId) return null
  const fresh = view.receivedAt !== null && Date.now() - view.receivedAt < STALE_SAMPLE_MS
  const cpu = fresh ? formatPct(view.cpu) : null
  return (
    <>
      <TooltipButton
        ref={triggerRef}
        title={
          cpu === null
            ? `Machine telemetry — ${machineLabel(hostId)}`
            : `${machineLabel(hostId)}: CPU ${cpu}, memory ${formatPct(view.memPct)}`
        }
        aria-label="Machine telemetry"
        aria-expanded={open}
        onClick={() => setOpen((was) => !was)}
        className={clsx(
          'flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 transition-colors',
          open
            ? 'bg-accent-soft text-accent'
            : 'text-text-tertiary hover:text-text hover:bg-bg-secondary',
        )}
      >
        <MachinesIcon />
        {cpu !== null && <span className="font-mono text-2xs tabular-nums">{cpu}</span>}
      </TooltipButton>
      {open && (
        <HostTelemetryPopover
          hostId={hostId}
          hostIds={hostIds}
          onSelectHost={setChosen}
          onClose={() => setOpen(false)}
          triggerRef={triggerRef}
        />
      )}
    </>
  )
}

/**
 * The machine to show when nobody has chosen: This Mac's service when it has
 * one, then any machine that is answering, then whatever is listed.
 */
function preferredHost(hosts: HostsSnapshot, chosen: string | null): string | null {
  if (chosen && hosts[chosen]) return chosen
  const ids = Object.keys(hosts)
  if (ids.length === 0) return null
  const local = ids.find((id) => hosts[id]?.local)
  if (local) return local
  return ids.find((id) => hosts[id]?.state === 'ready') ?? ids[0] ?? null
}
