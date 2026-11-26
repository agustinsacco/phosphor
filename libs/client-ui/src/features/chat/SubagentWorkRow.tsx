import { TooltipButton } from '@/components/Tooltip'
import clsx from 'clsx'
import type { WorkEntry } from './currentWork'
import {
  activityParts,
  batchTitle,
  elapsed,
  modelLabel,
  stateWord,
  workTime,
} from './subagentPresentation'
import { shortId } from './subagentRuns'

/** Section labels above groups of rows, in the app's eyebrow style. */
export const WORK_SECTION_CLASS =
  'text-text-tertiary px-2 pt-2 pb-0.5 font-mono text-xs uppercase tracking-wider'

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
  const title = entry.title ?? entry.label
  // The name starts with the visible title, so readers and voice control can
  // tell rows apart when several run the same agent.
  const label = `${title === entry.label ? title : `${title} · ${entry.label}`}: ${entry.state}${entry.currentTool ? ` · ${entry.currentTool}` : ''}${entry.active && entry.attention ? ' · needs parent attention' : ''}`
  const { lead, toolTime, count } = activityParts(entry, now)
  const when = workTime(entry.startedAt, entry.endedAt, entry.requestedAt)
  const time =
    entry.active && entry.startedAt !== undefined
      ? elapsed(now - entry.startedAt)
      : entry.state === 'status unavailable'
        ? 'status unavailable'
        : stateWord(entry.state)
  const context = [
    title !== entry.label && entry.label,
    entry.model && modelLabel(entry.model),
    !grouped && entry.group && entry.childId && `in ${entry.group.label}`,
  ]
    .filter(Boolean)
    .join(' · ')
  const tail = [
    count,
    entry.active > 0 && entry.attention && (
      <span key="attention" className="text-text font-medium">
        needs parent attention
      </span>
    ),
  ].filter(Boolean)
  const before = !!(context || lead)
  return (
    <TooltipButton
      type="button"
      data-testid="subagent-work-row"
      onClick={onClick}
      aria-label={label}
      aria-pressed={selected}
      aria-description={`${title}. ${when}.${entry.model ? ` ${entry.model}.` : ''} ${entry.runId ?? entry.id}`}
      tooltip={{
        label: title.length > 120 ? `${title.slice(0, 119)}…` : title,
        description: `${when} · ${entry.model ? `${entry.model} · ` : ''}${entry.runId ?? entry.id}`,
      }}
      className="text-text hover:bg-bg aria-pressed:bg-accent-soft flex w-full min-w-0 items-start gap-2 rounded-md px-2 py-1.5 text-left focus-visible:outline-2 focus-visible:outline-accent"
    >
      <span className="flex h-5 shrink-0 items-center">
        <SubagentStateDot entry={entry} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2 text-base leading-5">
          <span className="min-w-0 flex-1 truncate font-medium">{title}</span>
          <span
            className={clsx(
              'shrink-0 text-sm tabular-nums',
              entry.state === 'failed' ? 'text-danger' : 'text-text-secondary',
            )}
          >
            {time}
          </span>
        </span>
        {/* A long tool name truncates; its duration and the counters stay. */}
        <span className="text-text-secondary flex min-w-0 text-sm leading-4 whitespace-pre">
          <span className="min-w-0 truncate">
            {context}
            {context && lead && ' · '}
            {lead && (
              <span className={clsx(entry.currentTool && 'tool-running-label')}>{lead}</span>
            )}
          </span>
          {(toolTime || tail.length > 0) && (
            <span className="shrink-0 tabular-nums">
              {toolTime && ` ${toolTime}`}
              {tail.flatMap((part, i) => (i || before ? [' · ', part] : [part]))}
            </span>
          )}
          {!grouped && entry.runId && (
            <>
              {(before || tail.length > 0) && <span className="shrink-0"> · </span>}
              {/* Identity gives way first; the tooltip keeps the full run ID. */}
              <span className="text-text-tertiary min-w-0 shrink-[100] truncate">
                #{shortId(entry.runId)}
              </span>
            </>
          )}
        </span>
      </span>
    </TooltipButton>
  )
}

/** Consecutive members split where `nested` changes, so nested work indents together. */
const nestedRuns = (entries: WorkEntry[]): WorkEntry[][] =>
  entries.reduce<WorkEntry[][]>((runs, entry) => {
    const last = runs.at(-1)
    if (last && !!last[0]!.nested === !!entry.nested) last.push(entry)
    else runs.push([entry])
    return runs
  }, [])

/**
 * One launch of several agents: a header naming the batch, then its members as
 * peers. Only work below a member is indented under a rail.
 */
export function SubagentBatchGroup({
  group,
  members,
  pressed,
  onSelect,
  row,
}: {
  group: NonNullable<WorkEntry['group']>
  members: WorkEntry[]
  pressed: boolean
  onSelect: () => void
  row: (entry: WorkEntry) => React.JSX.Element
}): React.JSX.Element {
  const title = batchTitle(group, members.length)
  return (
    <div className="min-w-0">
      <TooltipButton
        type="button"
        aria-label={title}
        tooltip={{ label: title, description: `#${shortId(group.id)}` }}
        aria-pressed={pressed}
        onClick={onSelect}
        className="text-text-secondary hover:text-text aria-pressed:bg-accent-soft block w-full truncate rounded px-2 py-1 text-left text-xs"
      >
        {title}
      </TooltipButton>
      {nestedRuns(members).map((run) =>
        run[0]!.nested ? (
          <div key={run[0]!.id} data-nested className="border-border ml-3 border-l pl-1">
            {run.map(row)}
          </div>
        ) : (
          run.map(row)
        ),
      )}
    </div>
  )
}
