import { TooltipButton } from '@/components/Tooltip'
import type { WorkEntry } from './currentWork'
import { taskPreview, workTime } from './subagentPresentation'
import { shortId } from './subagentRuns'

/** Three stable lines: task, agent/activity, and a qualified execution time + identity. */
export function SubagentWorkRow({
  entry,
  onClick,
  selected,
  source,
}: {
  entry: WorkEntry
  onClick: () => void
  selected?: boolean
  source?: string
}): React.JSX.Element {
  const label = `${entry.label}: ${entry.state}${entry.currentTool ? ` · ${entry.currentTool}` : ''}${entry.active && entry.attention ? ' · needs parent attention' : ''}`
  const title = entry.task ? taskPreview(entry.task) : entry.label
  const time = workTime(entry.startedAt, entry.endedAt, entry.requestedAt)
  return (
    <TooltipButton
      type="button"
      onClick={onClick}
      aria-label={label}
      aria-description={`${title}. ${time}. ${entry.id}`}
      aria-pressed={selected}
      tooltip={{ label: title.length > 120 ? `${title.slice(0, 119)}…` : title, description: time }}
      className="text-text hover:bg-bg-secondary aria-pressed:bg-accent-soft block w-full min-w-0 rounded-md px-2 py-1.5 text-left focus-visible:outline-2 focus-visible:outline-accent"
    >
      <span className="flex items-baseline gap-2 text-sm">
        <span className="min-w-0 flex-1 truncate font-medium">{title}</span>
        <span className="text-text-secondary max-w-32 shrink-0 truncate text-xs">
          {entry.state}
        </span>
      </span>
      <span className="text-text-secondary block truncate text-xs">
        {entry.label}
        {source && ` · ${source}`}
        {entry.currentTool ? ` · ${entry.currentTool}` : !entry.task ? ' · Task not reported' : ''}
        {entry.active > 0 && entry.attention && ' · needs parent attention'}
      </span>
      <span className="text-text-tertiary block truncate text-xs">
        {time} · #
        {entry.toolCallId
          ? entry.toolCallId.slice(-8)
          : shortId(entry.childId ?? entry.runId ?? entry.id)}
      </span>
    </TooltipButton>
  )
}
