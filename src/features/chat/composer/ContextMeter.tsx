import { useCallback, useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import { useChatStore } from '@/stores/chat'
import { PopupMenu } from '@/components/PopupMenu'
import { RefreshIcon, Spinner } from '@/components/icons'
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
import { HEADROOM_STATUS_KEY, parseHeadroomStatus } from './headroomStatus'
import { assessBurn, burnSamples } from '@/lib/burnRate'
import {
  compactReset,
  isClaudeCliModel,
  usageStroke,
  usageTextClass,
  usageUnavailableReason,
  windowResetLabel,
  windowShortTitle,
  windowTitle,
} from '@/lib/claudeUsage'
import { moveTargets, type MoveTarget } from '@/lib/claudeGateway'
import type {
  ClaudeSessionAccount,
  ClaudeUsageSnapshotResult,
  ClaudeUsageWindow,
} from '@shared/models'
import { useSessionClaudeAccount } from './useSessionAccount'
import { useSessionsStore } from '@/stores/sessions'

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
  // Only pushed once the bundled headroom extension has compressed something,
  // so sessions without a proxy never grow the section.
  const headroomStatus = useExtensionUiStore((s) => s.statuses[sessionId]?.[HEADROOM_STATUS_KEY])

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
          className="absolute bottom-full left-0 mb-2 w-[27rem] max-w-[calc(100vw-3rem)]"
        >
          {/* Wide and two-column on purpose: stacked single-column sections
              grew this panel taller than the window, and it anchors upward, so
              the overflow clipped the heading. The scroller is the backstop
              for a short window or a session with many usage windows. */}
          <div className="max-h-[min(42rem,calc(100vh-9rem))] overflow-y-auto p-3">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-text text-lg font-medium">Session usage</span>
              <span className="text-text-secondary font-mono text-sm tabular-nums">
                {percent === null
                  ? usage?.contextWindow
                    ? `measuring · ${formatTokens(usage.contextWindow)}`
                    : 'measuring'
                  : `${formatTokens(usage?.tokens ?? 0)} / ${formatTokens(usage?.contextWindow ?? 0)} · ${percent}%`}
              </span>
            </div>
            {burning && (
              <div
                className={clsx(
                  'mt-2 rounded-md border px-2.5 py-2 text-sm leading-snug',
                  burn.level === 'runaway'
                    ? 'border-danger/30 bg-danger-soft text-danger'
                    : 'border-warning/30 bg-warning/10 text-warning',
                )}
              >
                {formatTokens(Math.round(burn.tokensPerMinute))} tokens/min, cache writes
                accelerating
                {burn.acceleration != null && ` ${burn.acceleration.toFixed(1)}×`} — the signature
                of a loop re-sending context it already has. Only {(burn.yield * 100).toFixed(1)}%
                of the spend reaches output; worth stopping the turn.
              </div>
            )}
            <ContextComposition
              statusText={breakdownStatus}
              total={usage?.tokens ?? 0}
              window={usage?.contextWindow ?? 0}
            />
            <div className="border-border/60 mt-2 grid grid-cols-2 gap-x-5 border-t pt-1.5 text-base">
              <div>
                <SectionLabel>Tokens</SectionLabel>
                <StatRow label="Input" value={formatTokens(stats.tokens.input)} />
                <StatRow label="Output" value={formatTokens(stats.tokens.output)} />
                <StatRow label="Cache read" value={formatTokens(stats.tokens.cacheRead)} />
                <StatRow label="Cache write" value={formatTokens(stats.tokens.cacheWrite)} />
              </div>
              <div>
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
                      className="text-warning truncate hover:underline"
                    >
                      no pricing →
                    </button>
                  </div>
                ) : (
                  <StatRow label="Cost" value={formatCost(stats.cost)} />
                )}
                <StatRow label="Messages" value={String(stats.totalMessages)} />
                <StatRow label="Tool calls" value={String(stats.toolCalls)} />
              </div>
            </div>
            <HeadroomSavings statusText={headroomStatus} />
            {isClaudeCliModel(model) && <PlanUsage sessionId={sessionId} />}
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
 *
 * The legend is two columns: four components plus free space is five rows of
 * mostly empty width, and the panel's height is the scarce resource here.
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
    <div className="pt-2">
      <div className="bg-bg-secondary flex h-2 overflow-hidden rounded-full">
        {slices.map((slice) => (
          <div
            key={slice.key}
            style={{ width: `${slice.percent}%`, backgroundColor: slice.color }}
            title={`${slice.label}: ${formatTokens(slice.tokens)}`}
          />
        ))}
      </div>
      <div className="mt-1.5 grid grid-cols-2 gap-x-5 gap-y-0.5 text-base">
        {slices.map((slice) => (
          <div key={slice.key} className="flex items-center gap-1.5">
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
            <span className="text-text-tertiary w-9 text-right font-mono text-sm tabular-nums">
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
 *
 * Chips rather than rows: what matters per server is a name and a number, and
 * a row each spent a line of height on 25 characters of it.
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
      <div className="flex flex-wrap gap-1">
        {rows.map((row) => (
          <span
            key={row.name}
            title={`${row.name}: ${row.count} tool schema${row.count === 1 ? '' : 's'} in the window, ~${formatTokens(row.tokens)} tokens. One schema per server is the MCP gateway's proxy tool — that server's own tools are fetched on demand, not carried in context.`}
            className="bg-bg-secondary text-text-secondary flex items-baseline gap-1.5 rounded px-1.5 py-0.5 font-mono text-sm"
          >
            <span className="max-w-[9rem] truncate">{row.name}</span>
            <span className="text-text-tertiary tabular-nums">{formatTokens(row.tokens)}</span>
          </span>
        ))}
      </div>
    </div>
  )
}

/**
 * Live plan usage — the same numbers the CLI's own `/usage` panel and Claude
 * Desktop show, at any percentage. Fetched when the popover opens (the fetch
 * spawns `claude -p /usage`: zero quota, ~1.5 s, cached ~60 s in main), so it
 * is always current the moment someone looks — which is the entire point of
 * this section: `PlanLimits` below only ever sees a window once the CLI's
 * warning threshold has crossed it. The refresh control re-reads past that
 * cache, because a number someone clicked for must be the current one.
 *
 * The section always renders: "Checking…" while the run is in flight, then
 * either the windows or the reason there are none. It used to disappear on a
 * failed fetch, which is indistinguishable from a fetch that never happened —
 * and the fetch not happening was the actual bug (the meter had unmounted).
 */
function PlanUsage({ sessionId }: { sessionId: string }): React.JSX.Element {
  const [state, setState] = useState<ClaudeUsageSnapshotResult | null>(null)
  const [reload, setReload] = useState(0)
  const { account, ready } = useSessionClaudeAccount(sessionId)
  // Only a click may skip main's 60 s cache. Read and cleared inside the
  // effect so an account change afterwards is an ordinary cached read again.
  const forceNext = useRef(false)

  useEffect(() => {
    // Whose quota this lane is eating decides WHICH account's windows to read.
    // Asking without an account id runs `claude -p /usage` under whichever
    // credential the CLI keeps by default, which on a multi-account install is
    // routinely a different plan than the lane is spending.
    if (!ready) return
    const force = forceNext.current
    forceNext.current = false
    let cancelled = false
    setState(null)
    void window.pidex
      .invoke('claude:usageSnapshot', account?.id, force)
      // A rejected invoke (no handler, main-process restart) must read as a
      // failed run, not as a permanent "Checking…".
      .catch((): ClaudeUsageSnapshotResult => ({ ok: false, error: 'run-failed' }))
      .then((result) => {
        if (!cancelled) setState(result)
      })
    return () => {
      cancelled = true
    }
  }, [account?.id, ready, reload])

  const refresh = useCallback((): void => {
    forceNext.current = true
    setReload((n) => n + 1)
  }, [])

  // One account, or an account pidex cannot name: the old wording was right.
  const who = account && account.total > 1 ? (account.email ?? account.label) : 'Claude account'
  const stale = state?.ok === true && state.snapshot.stale

  return (
    <section className="border-border/60 mt-2 border-t pt-1.5">
      <div className="flex items-center justify-between gap-2">
        <SectionLabel>{`Plan usage · ${who}${stale ? ' · last known' : ''}`}</SectionLabel>
        <button
          onClick={refresh}
          disabled={state === null}
          title="Re-read this account's usage from the Claude CLI"
          className="text-text-tertiary hover:text-text hover:bg-bg-secondary -mr-1 flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-sm transition-colors disabled:opacity-50"
        >
          {state === null ? <Spinner className="text-text-tertiary" /> : <RefreshIcon />}
          Refresh
        </button>
      </div>
      {state === null ? (
        <div className="text-text-tertiary text-sm">Checking…</div>
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
      <AccountRouting sessionId={sessionId} account={account} />
    </section>
  )
}

/**
 * One window as a dial: the arc carries the proportion, the number in the
 * middle carries the value, and the caption under it says which window and
 * when it clears. Three of these occupy one row where three labelled bars
 * occupied three, and the arc reads at a glance from across a desk.
 */
function UsageDial({ window }: { window: ClaudeUsageWindow }): React.JSX.Element {
  const percent = Math.round(window.percentUsed)
  const reset = compactReset(window.resetsAt)
  const full = windowResetLabel(window.resetsAt)
  // r=17 on a 42px box: circumference 2πr, so the dash is the arc's share.
  const circumference = 2 * Math.PI * 17
  return (
    <div
      className="flex flex-col items-center gap-0.5"
      title={`${windowTitle(window)} — ${percent}% used${full ? ` · ${full}` : ''}`}
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

/**
 * Which login this lane is spending, and how to put it on another one.
 *
 * A running lane cannot change account in place — the credential is fixed by
 * the environment pi was spawned with — so switching is dispose-and-resume:
 * the same session file, respawned against the chosen account. That costs a
 * full re-read of the thread, so it is a deliberate click, never automatic.
 * Silent with one account configured, because there is nowhere to go.
 *
 * The target list is fetched only when the picker is opened: `claude:accounts`
 * runs `claude auth status` per account, and paying that on every popover open
 * for a control most opens never touch is not a trade worth making.
 */
function AccountRouting({
  sessionId,
  account,
}: {
  sessionId: string
  account: ClaudeSessionAccount | null
}): React.JSX.Element | null {
  const moveSessionToAccount = useSessionsStore((s) => s.moveSessionToAccount)
  const [picking, setPicking] = useState(false)
  const [targets, setTargets] = useState<MoveTarget[] | null>(null)
  const [moving, setMoving] = useState<string | null>(null)
  if (!account || account.total < 2) return null

  const held = account.cooldownUntil !== null

  const open = (): void => {
    setPicking((p) => !p)
    if (targets !== null) return
    void window.pidex
      .invoke('claude:accounts')
      .then((result) => setTargets(moveTargets(result.views, account.id)))
      .catch(() => setTargets([]))
  }

  return (
    <div className="mt-1.5 text-sm">
      <div className="flex items-start justify-between gap-2">
        {/* Wraps rather than truncates: the held case names the account the
            next lane goes to, which is the whole point of the sentence. */}
        <span className={clsx('flex-1 leading-snug', held ? 'text-warning' : 'text-text-tertiary')}>
          {held
            ? account.mode === 'specific'
              ? 'Out of plan allowance, and routing is pinned here — Settings → Claude Code.'
              : account.alternative
                ? `Out of plan allowance. New sessions go to ${account.alternative.label}.`
                : 'Out of plan allowance, and every other account is too.'
            : `Spending ${account.email ?? account.label} of ${account.total} accounts.`}
        </span>
        <button
          onClick={open}
          className="text-accent shrink-0 hover:underline"
          aria-expanded={picking}
        >
          {picking ? 'Cancel' : 'Switch account'}
        </button>
      </div>
      {picking && (
        <div className="border-border/60 mt-1.5 space-y-0.5 rounded-md border p-1">
          {targets === null ? (
            <div className="text-text-tertiary flex items-center gap-1.5 px-1 py-0.5">
              <Spinner className="text-text-tertiary" /> Reading accounts…
            </div>
          ) : targets.length === 0 ? (
            <div className="text-text-tertiary px-1 py-0.5">
              No other signed-in account to move this session to.
            </div>
          ) : (
            <>
              {targets.map((target) => (
                <button
                  key={target.id}
                  disabled={moving !== null}
                  onClick={() => {
                    setMoving(target.id)
                    void moveSessionToAccount(sessionId, target.id).finally(() => {
                      setMoving(null)
                      setPicking(false)
                    })
                  }}
                  className="hover:bg-bg-secondary flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left transition-colors disabled:opacity-50"
                >
                  {/* Fixed slot so a row does not jump when its spinner appears. */}
                  <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
                    {moving === target.id && <Spinner className="text-accent" />}
                  </span>
                  <span className="text-text flex-1 truncate">{target.label}</span>
                  {target.held && <span className="text-warning shrink-0 text-2xs">held</span>}
                  {account.alternative?.id === target.id && !target.held && (
                    <span className="text-text-tertiary shrink-0 text-2xs">next in routing</span>
                  )}
                </button>
              ))}
              <div className="text-text-tertiary px-1.5 pt-0.5 text-2xs leading-snug">
                Restarts this lane on the chosen account: same session file, one full re-read of the
                thread.
              </div>
            </>
          )}
        </div>
      )}
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
    <section className="border-border/60 mt-2 border-t pt-1.5 text-base">
      <div className="flex items-center justify-between gap-3">
        <span className="text-text-tertiary truncate">
          <span className="font-mono text-2xs uppercase tracking-wider">Claude Code</span> ·{' '}
          {windowLabel(limit.windowType)}
        </span>
        <span
          className={clsx(
            'shrink-0 font-mono text-sm tabular-nums',
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
    </section>
  )
}

/**
 * Cumulative Headroom compression savings for this session. Absent unless the
 * bundled headroom extension has actually compressed a result — no proxy, no
 * section. "Skipped as lossy" is what the proxy offered but the extension
 * refused because the transform dropped lines irreversibly; it is the honest
 * ceiling, not a saving.
 *
 * Full width rather than a column, and the saving in the section header: three
 * labelled rows in the Session column would have wrapped `48k → 36k · 120 ms`
 * onto two lines each, which is the height this panel was redesigned to stop
 * spending.
 */
function HeadroomSavings({
  statusText,
}: {
  statusText: string | undefined
}): React.JSX.Element | null {
  const status = parseHeadroomStatus(statusText)
  if (!status) return null
  return (
    <section className="border-border/60 mt-2 border-t pt-1.5 text-base">
      <div className="flex items-baseline justify-between gap-2">
        <SectionLabel>Optimization · Headroom</SectionLabel>
        <span
          className="text-success shrink-0 font-mono text-sm tabular-nums"
          title="Tokens this session never had to carry"
        >
          −{formatTokens(status.savedTokens)}
        </span>
      </div>
      <div className="text-text-tertiary flex items-baseline justify-between gap-3">
        <span className="truncate">
          {formatTokens(status.beforeTokens)} → {formatTokens(status.afterTokens)} over{' '}
          {status.results} result{status.results === 1 ? '' : 's'}
        </span>
        <span className="text-text-secondary shrink-0 font-mono text-sm tabular-nums">
          {status.lastMs} ms last
        </span>
      </div>
      {status.skippedLossyTokens > 0 && (
        <div className="text-text-tertiary flex items-baseline justify-between gap-3">
          <span className="truncate">Skipped as lossy</span>
          <span className="shrink-0 font-mono text-sm tabular-nums">
            {formatTokens(status.skippedLossyTokens)}
          </span>
        </div>
      )}
    </section>
  )
}

function SectionLabel({ children }: { children: string }): React.JSX.Element {
  return (
    <div className="text-text-tertiary text-2xs truncate pb-0.5 font-mono uppercase tracking-wider">
      {children}
    </div>
  )
}

function StatRow({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-text-tertiary truncate">{label}</span>
      <span className="text-text-secondary shrink-0 font-mono text-sm tabular-nums">{value}</span>
    </div>
  )
}
