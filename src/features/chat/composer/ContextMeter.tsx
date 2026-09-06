import { useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import { useChatStore } from '@/stores/chat'
import { PopupMenu } from '@/components/PopupMenu'
import { formatCost, formatTokens } from '@/lib/format'
import { hasNoPricing } from './pricing'
import { useSettingsUiStore } from '@/features/settings/settingsUiStore'
import { useExtensionUiStore } from '@/stores/extensionUi'
import {
  CONTEXT_BREAKDOWN_STATUS_KEY,
  breakdownSlices,
  mcpServerRows,
  parseContextBreakdown,
  type ContextBreakdown,
} from './contextBreakdown'
import {
  RATE_LIMIT_STATUS_KEY,
  isPaidWindow,
  parseRateLimit,
  resetLabel,
  utilizationPercent,
  windowLabel,
} from './rateLimit'
import { assessBurn, burnSamples } from '@/lib/burnRate'
import {
  isClaudeCliModel,
  usageBarClass,
  usageTextClass,
  usageUnavailableReason,
  windowResetLabel,
  windowTitle,
} from '@/lib/claudeUsage'
import type { ClaudeUsageSnapshotResult, ClaudeUsageWindow } from '@shared/models'

export function ContextMeter({ sessionId }: { sessionId: string }): React.JSX.Element | null {
  const stats = useChatStore((s) => s.sessions[sessionId]?.stats)
  const model = useChatStore((s) => s.sessions[sessionId]?.meta?.model)
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  // Pushed by the bundled context-breakdown extension, so it is present for
  // every provider — including ones pidex knows nothing about.
  const breakdownStatus = useExtensionUiStore(
    (s) => s.statuses[sessionId]?.[CONTEXT_BREAKDOWN_STATUS_KEY],
  )
  // Only sessions served by the Claude Code provider push this; every other
  // provider leaves the key unset and the section stays hidden.
  const rateLimitStatus = useExtensionUiStore((s) => s.statuses[sessionId]?.[RATE_LIMIT_STATUS_KEY])

  const usage = stats?.contextUsage
  // The meter is the ONLY way into this popover, and the popover is where a
  // Claude session's plan usage lives — so it must not vanish when the
  // percentage is briefly unknown. pi reports null context tokens from the
  // moment a session compacts until fresh usage arrives, and returning null
  // there took the ring, the popover and the usage fetch with it. Render
  // whenever the session has stats and show the ring unfilled instead.
  if (!stats) return null

  const percent = usage?.percent == null ? null : Math.min(100, Math.round(usage.percent))
  const warn = percent !== null && percent >= 75
  const critical = percent !== null && percent >= 90
  // A loop that re-sends context it already delivered is invisible in the
  // percentage — it can bill millions without the meter moving.
  const burn = assessBurn(burnSamples(sessionId), Date.now())
  const burning = burn?.level === 'runaway' || burn?.level === 'elevated'

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        onClick={() => setOpen((o) => !o)}
        title={
          percent === null
            ? 'Context: measuring — session usage'
            : `Context: ${percent}% of ${formatTokens(usage?.contextWindow ?? 0)}`
        }
        className="hover:bg-bg-secondary flex items-center gap-1.5 rounded-md px-2 py-1 transition-colors"
      >
        <svg width="15" height="15" viewBox="0 0 16 16" className="-rotate-90">
          <circle
            cx="8"
            cy="8"
            r="6.5"
            fill="none"
            stroke="var(--px-border-strong)"
            strokeWidth="2"
          />
          <circle
            cx="8"
            cy="8"
            r="6.5"
            fill="none"
            stroke={
              critical ? 'var(--px-danger)' : warn ? 'var(--px-warning)' : 'var(--px-success)'
            }
            strokeWidth="2"
            strokeDasharray={`${((percent ?? 0) / 100) * 40.8} 40.8`}
            strokeLinecap="round"
          />
        </svg>
        <span
          className={clsx(
            'text-base tabular-nums',
            critical ? 'text-danger' : warn ? 'text-warning' : 'text-text-secondary',
          )}
        >
          {percent === null ? '—' : `${percent}%`}
        </span>
        {burning && (
          <span
            className={clsx(
              'text-2xs font-mono uppercase tracking-wide',
              burn.level === 'runaway' ? 'text-danger' : 'text-warning',
            )}
          >
            {formatTokens(Math.round(burn.tokensPerMinute))}/min
          </span>
        )}
      </button>

      {open && (
        <PopupMenu
          onClose={() => setOpen(false)}
          triggerRef={triggerRef}
          fitViewport
          className="absolute bottom-full left-0 mb-2 w-80 max-w-[calc(100vw-16rem)] p-3"
        >
          <div className="text-text text-base font-medium">Session usage</div>
          {burning && (
            <div
              className={clsx(
                'mt-2 rounded-md border px-2.5 py-2 text-sm leading-snug',
                burn.level === 'runaway'
                  ? 'border-danger/30 bg-danger-soft text-danger'
                  : 'border-warning/30 bg-warning/10 text-warning',
              )}
            >
              {formatTokens(Math.round(burn.tokensPerMinute))} tokens/min, cache writes accelerating
              {burn.acceleration != null && ` ${burn.acceleration.toFixed(1)}×`} — the signature of
              a loop re-sending context it already has. Only {(burn.yield * 100).toFixed(1)}% of the
              spend reaches output; worth stopping the turn.
            </div>
          )}
          <div className="mt-2 space-y-1 text-base">
            <SectionLabel>Context</SectionLabel>
            <StatRow
              label="Window"
              value={
                percent === null
                  ? usage?.contextWindow
                    ? `measuring — ${formatTokens(usage.contextWindow)} window`
                    : 'measuring'
                  : `${formatTokens(usage?.tokens ?? 0)} / ${formatTokens(usage?.contextWindow ?? 0)} (${percent}%)`
              }
            />
            <ContextComposition
              statusText={breakdownStatus}
              total={usage?.tokens ?? 0}
              window={usage?.contextWindow ?? 0}
            />
            <SectionLabel>Tokens</SectionLabel>
            <StatRow label="Input" value={formatTokens(stats.tokens.input)} />
            <StatRow label="Output" value={formatTokens(stats.tokens.output)} />
            <StatRow label="Cache read" value={formatTokens(stats.tokens.cacheRead)} />
            <StatRow label="Cache write" value={formatTokens(stats.tokens.cacheWrite)} />
            <SectionLabel>Session</SectionLabel>
            {stats.cost === 0 && hasNoPricing(model) ? (
              <div className="text-text-tertiary flex items-center justify-between gap-3">
                <span>Cost</span>
                <button
                  onClick={() => {
                    setOpen(false)
                    const settingsUi = useSettingsUiStore.getState()
                    settingsUi.setTab('advanced')
                    settingsUi.setOpen(true)
                  }}
                  title={`No pricing configured for ${model?.name ?? 'this model'} — add cost rates to models.json`}
                  className="text-warning hover:underline"
                >
                  no pricing configured →
                </button>
              </div>
            ) : (
              <StatRow label="Cost" value={formatCost(stats.cost)} />
            )}
            <StatRow label="Messages" value={String(stats.totalMessages)} />
            <StatRow label="Tool calls" value={String(stats.toolCalls)} />
            {isClaudeCliModel(model) && <PlanUsage />}
            <PlanLimits statusText={rateLimitStatus} />
          </div>
        </PopupMenu>
      )}
    </div>
  )
}

/**
 * What is actually filling the window. Absent until the bundled extension
 * reports (first turn of a session), and silently absent if a user runs pi
 * without pidex's extensions — the meter must still work.
 */
function ContextComposition({
  statusText,
  total,
  window,
}: {
  statusText: string | undefined
  total: number
  window: number
}): React.JSX.Element | null {
  const breakdown = parseContextBreakdown(statusText)
  if (!breakdown || window <= 0) return null
  const slices = breakdownSlices(breakdown, total, window)
  if (slices.length <= 1) return null

  return (
    <div className="pt-1.5">
      <div className="bg-bg-secondary flex h-2 overflow-hidden rounded-full">
        {slices.map((slice) => (
          <div
            key={slice.key}
            style={{ width: `${slice.percent}%`, backgroundColor: slice.color }}
            title={`${slice.label}: ${formatTokens(slice.tokens)}`}
          />
        ))}
      </div>
      <div className="mt-1.5 space-y-0.5">
        {slices.map((slice) => (
          <div key={slice.key} className="flex items-center gap-2">
            <span
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ backgroundColor: slice.color }}
              aria-hidden
            />
            <span className="text-text-tertiary flex-1 truncate">
              {slice.label}
              {slice.count !== undefined && slice.count > 0 && (
                <span className="text-text-tertiary/70"> · {slice.count}</span>
              )}
            </span>
            <span className="text-text-secondary font-mono text-sm tabular-nums">
              {formatTokens(slice.tokens)}
            </span>
            <span className="text-text-tertiary w-10 text-right font-mono text-sm tabular-nums">
              {slice.percent < 0.1 ? '<0.1' : slice.percent.toFixed(1)}%
            </span>
          </div>
        ))}
      </div>
      {breakdown.approximate && (
        <div className="text-text-tertiary pt-1 text-sm">
          Component sizes are estimates; the total is pi&apos;s own figure.
        </div>
      )}
      <McpServers breakdown={breakdown} total={total} />
    </div>
  )
}

/**
 * Which connector is costing what.
 *
 * Six connected servers with promoted tools can occupy more of the window than
 * the conversation does, and the single "MCP tools" slice cannot say which one
 * to disable. Absent until the adapter reports its servers, and hidden when
 * only one server exists — the slice above already answers that case.
 */
function McpServers({
  breakdown,
  total,
}: {
  breakdown: ContextBreakdown
  total: number
}): React.JSX.Element | null {
  const rows = mcpServerRows(breakdown, total)
  if (rows.length < 2) return null
  return (
    <div className="border-border/60 mt-2 border-t pt-1.5">
      <SectionLabel>MCP servers</SectionLabel>
      {rows.map((row) => (
        <div key={row.name} className="flex items-center gap-2">
          <span className="text-text-tertiary flex-1 truncate font-mono text-sm" title={row.name}>
            {row.name}
            <span className="text-text-tertiary/70"> · {row.count}</span>
          </span>
          <span className="text-text-secondary font-mono text-sm tabular-nums">
            {formatTokens(row.tokens)}
          </span>
        </div>
      ))}
    </div>
  )
}

/**
 * Live plan usage — the same numbers the CLI's own `/usage` panel and Claude
 * Desktop show, at any percentage. Fetched when the popover opens (the fetch
 * spawns `claude -p /usage`: zero quota, ~1.5 s, cached ~60 s in main), so it
 * is always current the moment someone looks — which is the entire point of
 * this section: `PlanLimits` below only ever sees a window once the CLI's
 * warning threshold has crossed it.
 *
 * The section always renders: "Checking…" while the run is in flight, then
 * either the windows or the reason there are none. It used to disappear on a
 * failed fetch, which is indistinguishable from a fetch that never happened —
 * and the fetch not happening was the actual bug (the meter had unmounted).
 */
function PlanUsage(): React.JSX.Element {
  const [state, setState] = useState<ClaudeUsageSnapshotResult | null>(null)

  useEffect(() => {
    let cancelled = false
    void window.pidex
      .invoke('claude:usageSnapshot')
      // A rejected invoke (no handler, main-process restart) must read as a
      // failed run, not as a permanent "Checking…".
      .catch((): ClaudeUsageSnapshotResult => ({ ok: false, error: 'run-failed' }))
      .then((result) => {
        if (!cancelled) setState(result)
      })
    return () => {
      cancelled = true
    }
  }, [])

  if (!state) {
    return (
      <>
        <SectionLabel>Plan usage · Claude account</SectionLabel>
        <div className="text-text-tertiary text-sm">Checking…</div>
      </>
    )
  }
  if (!state.ok || state.snapshot.windows.length === 0) {
    return (
      <>
        <SectionLabel>Plan usage · Claude account</SectionLabel>
        <div className="text-text-tertiary text-sm">
          {usageUnavailableReason(state.ok ? 'no-usage' : state.error)}
        </div>
      </>
    )
  }
  const { snapshot } = state

  return (
    <>
      <SectionLabel>
        {`Plan usage · Claude account${snapshot.stale ? ' · last known' : ''}`}
      </SectionLabel>
      <div className="space-y-1.5">
        {snapshot.windows.map((window) => (
          <UsageWindowRow key={window.label} window={window} />
        ))}
      </div>
    </>
  )
}

/** One window: title, percent, reset countdown, and the bar itself. */
function UsageWindowRow({ window }: { window: ClaudeUsageWindow }): React.JSX.Element {
  const percent = Math.round(window.percentUsed)
  const reset = windowResetLabel(window.resetsAt)
  return (
    <div>
      <div className="flex items-center justify-between gap-3">
        <span className="text-text-tertiary">{windowTitle(window)}</span>
        <span
          className={clsx('font-mono text-sm tabular-nums', usageTextClass(percent))}
          title={reset ?? undefined}
        >
          {percent}%{percent >= 100 ? ' · over' : reset ? ` · ${reset}` : ''}
        </span>
      </div>
      <div className="bg-bg-secondary mt-1 h-1 overflow-hidden rounded-full">
        <div
          className={clsx('h-full rounded-full', usageBarClass(percent))}
          // Capped at 100 like PlanLimits: a 101% bar would overflow the
          // track, and the number beside it already says how far over.
          style={{ width: `${Math.min(100, percent)}%` }}
        />
      </div>
    </div>
  )
}

/**
 * Account-level usage window for Claude Code sessions.
 *
 * ONE window, not four: the CLI reports the first limit whose threshold has
 * been crossed, so this is the binding constraint — the one that will actually
 * stop you. `utilization` arrives from provider >= 0.4.9; older providers give
 * the window and its reset but no percentage, and the bar is omitted rather
 * than guessed at.
 */
function PlanLimits({ statusText }: { statusText: string | undefined }): React.JSX.Element | null {
  const limit = parseRateLimit(statusText)
  if (!limit) return null
  const reset = resetLabel(limit.resetsAt)
  const capped = limit.status === 'rejected'
  const percent = utilizationPercent(limit.utilization)
  // Past 100% on the credit bucket means real money is being spent per token,
  // which deserves the same colour as a hard cap rather than a mild warning.
  const over = percent !== null && percent >= 100
  const paid = isPaidWindow(limit.windowType)

  return (
    <>
      <SectionLabel>Plan limits · Claude Code</SectionLabel>
      <div className="flex items-center justify-between gap-3">
        <span className="text-text-tertiary">{windowLabel(limit.windowType)}</span>
        <span
          className={clsx(
            'font-mono text-sm tabular-nums',
            capped || over ? 'text-danger' : 'text-text-secondary',
          )}
        >
          {percent !== null && `${percent}% · `}
          {capped ? 'limit reached' : (reset ?? 'active')}
        </span>
      </div>
      {percent !== null && (
        <div className="bg-bg-secondary mt-1 h-1 overflow-hidden rounded-full">
          <div
            className={clsx(
              'h-full rounded-full',
              capped || over ? 'bg-danger' : percent >= 75 ? 'bg-warning' : 'bg-accent',
            )}
            // Bar caps at 100% even when utilization does not: a 101% bar
            // would overflow its track, and the number beside it already
            // says exactly how far over the line this is.
            style={{ width: `${Math.min(100, percent)}%` }}
          />
        </div>
      )}
      {paid && (
        <div className={clsx('text-sm', over ? 'text-danger' : 'text-warning')}>
          {over
            ? 'Over the credit allowance — further usage bills at standard API rates.'
            : 'Usage credits bill separately from the subscription.'}
        </div>
      )}
      {limit.isUsingOverage && !paid && (
        <div className="text-warning text-sm">Using extra usage beyond the plan allowance.</div>
      )}
      {capped && reset && <div className="text-text-tertiary text-sm">{reset}.</div>}
    </>
  )
}

function SectionLabel({ children }: { children: string }): React.JSX.Element {
  return (
    <div className="text-text-tertiary pb-0.5 pt-1.5 font-mono text-2xs uppercase tracking-wider first:pt-0">
      {children}
    </div>
  )
}

function StatRow({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-text-tertiary">{label}</span>
      <span className="text-text-secondary font-mono text-sm tabular-nums">{value}</span>
    </div>
  )
}
