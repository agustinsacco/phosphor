import { useEffect, useState } from 'react'
import clsx from 'clsx'
import { TooltipButton } from '@/components/Tooltip'
import { RefreshIcon, Spinner } from '@/components/icons'
import { useMachinesStore } from '@/stores/machines'
import { useSessionsStore } from '@/stores/sessions'
import {
  compactReset,
  usageStroke,
  usageTextClass,
  usageUnavailableReason,
  windowResetLabel,
  windowShortTitle,
  windowTitle,
} from '@/lib/claudeUsage'
import type { ClaudeUsageSnapshotResult, PlanUsageWindow } from '@shared/models'
import { HostAccountRouting } from './HostAccountRouting'

/**
 * A remote lane spends a Host's Claude login, not this computer's, so its plan
 * windows come from the Host (`machine.claudeUsage`): that machine's own
 * `claude -p /usage` for the account the lane bills. A Host older than the call
 * answers null, which the section says instead of hiding.
 */
export function HostPlanUsage({ sessionId }: { sessionId: string }): React.JSX.Element | null {
  const live = useSessionsStore((s) => s.live[sessionId])
  const hostId = live?.target?.kind === 'remote' ? live.target.hostId : undefined
  const laneId = live?.laneId
  const machine =
    useMachinesStore((s) => s.machines.find((m) => m.id === hostId)?.label) ?? 'remote machine'
  const [state, setState] = useState<ClaudeUsageSnapshotResult | 'unsupported' | null>(null)
  const [reload, setReload] = useState(0)
  useEffect(() => {
    if (!hostId) return
    let cancelled = false
    setState(null)
    void window.phosphor
      .invoke('hosts:claudeUsage', hostId, laneId, reload > 0)
      .catch(() => null)
      .then((result) => {
        if (!cancelled) setState(result ?? 'unsupported')
      })
    return () => {
      cancelled = true
    }
  }, [hostId, laneId, reload])
  const stale = state !== null && state !== 'unsupported' && state.ok && state.snapshot.stale
  if (!hostId) return null
  return (
    <PlanUsageView
      label={`Plan usage · Claude on ${machine}${stale ? ' · last known' : ''}`}
      refreshTitle={`Re-read this lane's account usage on ${machine}`}
      state={state === 'unsupported' ? null : state}
      unavailable={
        state === 'unsupported'
          ? `Plan usage is unavailable from ${machine}. Update its Host, then refresh.`
          : undefined
      }
      onRefresh={() => setReload((n) => n + 1)}
    >
      <HostAccountRouting sessionId={sessionId} onMoved={() => setReload((n) => n + 1)} />
    </PlanUsageView>
  )
}

export function PlanUsageView({
  label,
  refreshTitle,
  state,
  unavailable,
  onRefresh,
  children,
}: {
  label: string
  refreshTitle: string
  /** null while checking, unless `unavailable` explains why there is no answer. */
  state: ClaudeUsageSnapshotResult | null
  unavailable?: string
  onRefresh: () => void
  children?: React.ReactNode
}): React.JSX.Element {
  const checking = state === null && unavailable === undefined
  return (
    <section className="border-border/60 mt-2 border-t pt-1.5">
      <div className="flex items-center justify-between gap-2">
        <SectionLabel>{label}</SectionLabel>
        <TooltipButton
          onClick={onRefresh}
          disabled={checking}
          title={refreshTitle}
          className="text-text-tertiary hover:text-text hover:bg-bg-secondary -mr-1 flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-sm transition-colors disabled:opacity-50"
        >
          {checking ? <Spinner className="text-text-tertiary" /> : <RefreshIcon />}
          Refresh
        </TooltipButton>
      </div>
      {state === null ? (
        <div className="text-text-tertiary text-sm">{unavailable ?? 'Checking…'}</div>
      ) : !state.ok || state.snapshot.windows.length === 0 ? (
        <div className="text-text-tertiary text-sm">
          {usageUnavailableReason(state.ok ? 'no-usage' : state.error)}
        </div>
      ) : (
        <div className="grid grid-cols-3 gap-x-3 gap-y-2">
          {state.snapshot.windows.map((window) => (
            <UsageDial key={window.label} window={window} />
          ))}
        </div>
      )}
      {children}
    </section>
  )
}

/**
 * One window as a dial: the arc carries the proportion, the number in the
 * middle carries the value, and the caption under it says which window and
 * when it clears. Three of these occupy one row where three labelled bars
 * occupied three, and the arc reads at a glance from across a desk.
 */
export function UsageDial({ window }: { window: PlanUsageWindow }): React.JSX.Element {
  const percent = Math.round(window.percentUsed)
  const reset = compactReset(window.resetsAt)
  const full = windowResetLabel(window.resetsAt)
  // r=17 on a 42px box: circumference 2πr, so the dash is the arc's share.
  const circumference = 2 * Math.PI * 17
  return (
    <div
      className="flex flex-col items-center gap-0.5"
      data-tooltip={`${windowTitle(window)} — ${percent}% used${full ? ` · ${full}` : ''}`}
    >
      <div className="relative h-[42px] w-[42px]">
        <svg width="42" height="42" viewBox="0 0 42 42" className="-rotate-90">
          <circle
            cx="21"
            cy="21"
            r="17"
            fill="none"
            stroke="var(--px-border-strong)"
            strokeWidth="3.5"
            opacity="0.5"
          />
          <circle
            cx="21"
            cy="21"
            r="17"
            fill="none"
            stroke={usageStroke(percent)}
            strokeWidth="3.5"
            strokeLinecap="round"
            // Capped at 100 like the bars: a longer arc would lap the track,
            // and the number inside already says how far over this is.
            strokeDasharray={`${(Math.min(100, percent) / 100) * circumference} ${circumference}`}
          />
        </svg>
        {/* Inline `%`, not a flex child: it keeps the shared baseline with
            the number, and `leading-none` lets the grid centre the pair. */}
        <span className="absolute inset-0 grid place-items-center">
          <span
            className={clsx(
              'font-mono text-base leading-none tabular-nums',
              usageTextClass(percent),
            )}
          >
            {percent}
            <span className="text-2xs opacity-70">%</span>
          </span>
        </span>
      </div>
      <span className="text-text-secondary max-w-full truncate text-sm">
        {windowShortTitle(window)}
      </span>
      <span
        className={clsx(
          'text-2xs tabular-nums',
          percent >= 100 ? 'text-danger' : 'text-text-tertiary',
        )}
      >
        {percent >= 100 ? 'over' : (reset ?? 'no reset')}
      </span>
    </div>
  )
}

export function SectionLabel({ children }: { children: string }): React.JSX.Element {
  return (
    <div className="text-text-tertiary text-2xs truncate pb-0.5 font-mono uppercase tracking-wider">
      {children}
    </div>
  )
}
