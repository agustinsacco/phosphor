import { useMemo } from 'react'
import clsx from 'clsx'
import type { WorkspaceSessionStats } from '@shared/models'
import { TooltipSummary } from '@/components/Tooltip'
import { Button } from '@/components/form'
import { StatTile } from '@/components/StatTile'
import { formatCost, formatTokens } from '@/lib/format'
import { LaneBoard, useLaneBoard } from './LaneBoard'
import { Ledger } from './Ledger'
import { boardHeadline } from './laneState'

const WEEKS = 26

function Heatmap({ activityByDay }: { activityByDay: Record<string, number> }): React.JSX.Element {
  const cells = useMemo(() => {
    const today = new Date()
    const days: { key: string; count: number }[] = []
    for (let i = WEEKS * 7 - 1; i >= 0; i--) {
      const date = new Date(today)
      date.setDate(today.getDate() - i)
      const key = date.toISOString().slice(0, 10)
      days.push({ key, count: activityByDay[key] ?? 0 })
    }
    return days
  }, [activityByDay])

  const max = Math.max(1, ...cells.map((c) => c.count))

  return (
    <div className="mt-3 overflow-x-auto px-1">
      <div className="grid grid-flow-col gap-[3px]" style={{ gridTemplateRows: 'repeat(7, 10px)' }}>
        {cells.map((cell) => {
          const intensity = cell.count === 0 ? 0 : Math.max(0.25, Math.min(1, cell.count / max))
          return (
            <div
              key={cell.key}
              data-tooltip={`${cell.key}: ${cell.count} messages`}
              className={clsx(
                'h-[10px] w-[10px] rounded-[2.5px]',
                cell.count === 0 && 'bg-border/60',
              )}
              style={
                cell.count > 0
                  ? {
                      backgroundColor: `color-mix(in srgb, var(--px-accent) ${Math.round(intensity * 100)}%, var(--px-border) ${Math.round((1 - intensity) * 60)}%)`,
                    }
                  : undefined
              }
            />
          )
        })}
      </div>
    </div>
  )
}

function formatNumber(n: number): string {
  return n.toLocaleString()
}

/** Mounted only for This Mac: remote home never subscribes to the local lane board. */
export function LocalHomeDashboard({
  workspacePath,
  workspaceName,
  stats,
  username,
  onNew,
}: {
  workspacePath: string
  workspaceName: string
  stats: WorkspaceSessionStats | null
  username: string
  onNew: () => void
}): React.JSX.Element {
  const laneBoard = useLaneBoard(workspacePath)
  const headline = boardHeadline(laneBoard.board)
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="text-text-secondary mb-2 font-mono text-xs uppercase tracking-wider">
            {workspaceName}
          </p>
          <h1 className="text-4xl font-semibold tracking-tight">
            {laneBoard.board.lanes.length
              ? 'Your workbench'
              : `What's up next${username ? `, ${username}` : ''}?`}
          </h1>
          <p className="text-text-secondary mt-2 text-lg">
            {headline ?? 'Give each task a lane. Keep the work in view.'}
          </p>
        </div>
        <Button onClick={onNew}>New lane</Button>
      </div>

      <LaneBoard key={laneBoard.projectRoot} data={laneBoard} />
      <Ledger workspacePath={workspacePath} stats={stats} lanes={laneBoard.lanes} />

      {stats && stats.sessionCount > 0 && (
        <details className="border-border bg-bg-secondary/60 mt-6 rounded-xl border p-4">
          <TooltipSummary className="text-text-tertiary cursor-pointer text-sm">
            Project stats
          </TooltipSummary>
          <div className="mt-3 grid grid-cols-4 gap-2">
            <StatTile label="Sessions" value={formatNumber(stats.sessionCount)} />
            <StatTile label="Messages" value={formatNumber(stats.messages)} />
            <StatTile label="Total tokens" value={formatTokens(stats.tokens)} />
            <StatTile label="Active days" value={String(stats.activeDays)} />
          </div>
          <Heatmap activityByDay={stats.activityByDay} />
          {stats.cost > 0 && (
            <div className="text-text-tertiary mt-2 px-1 text-sm">
              You&apos;ve spent {formatCost(stats.cost)} thinking out loud in {workspaceName}.
            </div>
          )}
        </details>
      )}

      {stats && stats.sessionCount === 0 && laneBoard.board.lanes.length === 0 && (
        <p className="text-text-secondary mt-4 text-center text-lg">
          Start your first session in <span className="font-medium">{workspaceName}</span> —
          describe a task below.
        </p>
      )}
    </>
  )
}
