import { useMemo } from 'react'
import clsx from 'clsx'
import type { SessionMeta, WorkspaceSessionStats } from '@shared/models'
import { useSessionsStore } from '@/stores/sessions'
import { useExtensionUiStore } from '@/stores/extensionUi'
import { StatTile } from '@/components/StatTile'
import { formatCost, formatTokens } from '@/lib/format'
import { resetLabel, utilizationPercent, windowLabel } from '@/features/chat/composer/rateLimit'
import { bindingRateLimit, estimatedResidentMb, formatMb, topSpenders } from './accountUsage'
import { sessionTitle } from '@/lib/sessionTitle'

/**
 * What running this many lanes at once is costing.
 *
 * The two facts here belong to no single lane, which is why the sidebar cannot
 * show them: what the project has spent, and which account window will stop
 * you first. The window is the one that bites — several lanes on a frontier
 * model burn a 5-hour allowance in well under five hours, and without this the
 * first sign is a turn dying mid-edit.
 */
export function Ledger({
  workspacePath,
  stats,
  lanes,
}: {
  workspacePath: string
  stats: WorkspaceSessionStats | null
  /** Every lane of this project, for the per-lane spend bars. */
  lanes: SessionMeta[]
}): React.JSX.Element | null {
  const live = useSessionsStore((s) => s.live)
  const statuses = useExtensionUiStore((s) => s.statuses)

  const liveIds = useMemo(
    () =>
      Object.values(live)
        .filter(
          (entry) =>
            entry.workspacePath === workspacePath || lanes.some((m) => m.path === entry.diskPath),
        )
        .map((entry) => entry.phosphorId),
    [live, workspacePath, lanes],
  )

  const limit = useMemo(() => bindingRateLimit(statuses, liveIds), [statuses, liveIds])
  const percent = limit ? utilizationPercent(limit.utilization) : null

  const top = useMemo(() => topSpenders(lanes), [lanes])

  if (!stats || stats.sessionCount === 0) return null
  const residentMb = estimatedResidentMb(liveIds.length)

  return (
    <div className="mt-6 w-full" data-testid="home-ledger">
      <div className="grid grid-cols-3 gap-2">
        <StatTile label="Spent here" value={formatCost(stats.cost)} />
        <StatTile label="Tokens" value={formatTokens(stats.tokens)} />
        <StatTile
          label="Live"
          value={liveIds.length === 0 ? '0' : `${liveIds.length} · ~${formatMb(residentMb)}`}
        />
      </div>

      {limit && (
        <div className="mt-3" data-testid="ledger-window">
          <div className="mb-1 flex items-baseline justify-between text-xs">
            <span className="text-text-secondary">
              {windowLabel(limit.windowType)}
              {/* Status in words as well as colour: the bar alone cannot say
                  whether a high number is fine or already capped. */}
              <span
                className={clsx(
                  'ml-2 font-mono',
                  limit.status === 'rejected'
                    ? 'text-danger'
                    : (percent ?? 0) >= 80
                      ? 'text-warning'
                      : 'text-success',
                )}
              >
                {limit.status === 'rejected'
                  ? 'capped'
                  : percent === null
                    ? 'active'
                    : `${percent}% used`}
              </span>
            </span>
            {resetLabel(limit.resetsAt) && (
              <span className="text-text-tertiary font-mono">{resetLabel(limit.resetsAt)}</span>
            )}
          </div>
          {percent !== null && (
            <div className="bg-bg-secondary h-2 overflow-hidden rounded-full">
              <div
                className="bg-accent h-full rounded-full"
                style={{ width: `${Math.min(percent, 100)}%` }}
              />
            </div>
          )}
        </div>
      )}

      {top.length > 1 && (
        <div className="mt-4">
          <div className="text-text-tertiary mb-1.5 font-mono text-[10px] font-semibold uppercase tracking-wider">
            Spend by lane
          </div>
          {top.map((meta) => (
            <div key={meta.path} className="flex items-center gap-2 py-0.5 text-xs">
              <span className="text-text-secondary w-40 shrink-0 truncate">
                {sessionTitle({ explicitName: meta.name, firstUserText: meta.firstUserText }) ??
                  'Untitled'}
              </span>
              <span className="bg-bg-secondary h-2 min-w-0 flex-1 rounded-full">
                <span
                  className="bg-accent block h-full rounded-full"
                  style={{ width: `${Math.round((meta.cost / (top[0]?.cost || 1)) * 100)}%` }}
                />
              </span>
              <span className="text-text w-14 shrink-0 text-right font-mono tabular-nums">
                {formatCost(meta.cost)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
