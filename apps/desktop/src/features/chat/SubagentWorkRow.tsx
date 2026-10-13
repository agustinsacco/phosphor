import { TooltipButton } from '@/components/Tooltip'
import clsx from 'clsx'
import type { WorkEntry } from './currentWork'
import { activityText, elapsed, stateWord, workTime } from './subagentPresentation'
import { shortId } from './subagentRuns'

/** Pulses only while the agent runs; colour alone never carries the state. */
export function SubagentStateDot({ entry }: { entry: WorkEntry }): React.JSX.Element {
  return (
    <span
      aria-hidden
      className={clsx(
        'inline-block size-2 shrink-0 rounded-full',
        entry.active
          ? clsx('tool-running-dot', entry.attention ? 'bg-warning' : 'bg-accent')
          : entry.state === 'failed'
            ? 'bg-danger'
            : entry.state === 'status unavailable'
              ? 'border-text-tertiary border'
              : 'bg-text-tertiary',
      )}
    />
  )
}

/** Two fixed lines: what the agent was asked, and what it is doing now. */
export function SubagentWorkRow({
  entry,
  now,
  onClick,
  selected,
  grouped = false,
}: {
  entry: WorkEntry
  now: number
  onClick: () => void
  selected?: boolean
  /** Listed under its run's header, which already names the run. */
  grouped?: boolean
}): React.JSX.Element {
  const label = `${entry.label}: ${entry.state}${entry.currentTool ? ` · ${entry.currentTool}` : ''}${entry.active && entry.attention ? ' · needs parent attention' : ''}`
  const title = entry.title ?? entry.label
  const activity = activityText(entry, now)
  const when = workTime(entry.startedAt, entry.endedAt, entry.requestedAt)
  const time =
    entry.active && entry.startedAt !== undefined
      ? elapsed(now - entry.startedAt)
      : entry.state === 'status unavailable'
        ? 'status unavailable'
        : stateWord(entry.state)
  return (
    <TooltipButton
      type="button"
      data-testid="subagent-work-row"
      onClick={onClick}
      aria-label={label}
      aria-pressed={selected}
      aria-description={`${title}. ${when}. ${entry.runId ?? entry.id}`}
      tooltip={{
        label: title.length > 120 ? `${title.slice(0, 119)}…` : title,
        description: `${when} · ${entry.runId ?? entry.id}`,
      }}
      className="text-text hover:bg-bg aria-pressed:bg-accent-soft flex w-full min-w-0 items-start gap-2 rounded-md px-2 py-1.5 text-left focus-visible:outline-2 focus-visible:outline-accent"
    >
      <span className="flex h-5 shrink-0 items-center">
        <SubagentStateDot entry={entry} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2 text-sm leading-5">
          <span className="min-w-0 flex-1 truncate font-medium">{title}</span>
          <span
            className={clsx(
              'shrink-0 text-xs tabular-nums',
              entry.state === 'failed' ? 'text-danger' : 'text-text-secondary',
            )}
          >
            {time}
          </span>
        </span>
        <span className="text-text-secondary block truncate text-xs leading-4">
          {[
            title !== entry.label && entry.label,
            !grouped && entry.group && `in ${entry.group.label}`,
            activity && (
              <span
                key="activity"
                className={clsx(entry.active && entry.currentTool && 'tool-running-label')}
              >
                {activity}
              </span>
            ),
            entry.active > 0 && entry.attention && (
              <span key="attention" className="text-warning">
                needs parent attention
              </span>
            ),
            !grouped && entry.runId && (
              <span key="run" className="text-text-tertiary">
                #{shortId(entry.runId)}
              </span>
            ),
          ]
            .filter(Boolean)
            .flatMap((part, i) => (i ? [' · ', part] : [part]))}
        </span>
      </span>
    </TooltipButton>
  )
}
