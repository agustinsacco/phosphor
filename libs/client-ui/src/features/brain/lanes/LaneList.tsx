import { useState } from 'react'
import { useBrain } from '../useBrain'
import { brainLaneNeverRead } from '@shared/brain'
import type { BrainJob } from '@shared/brain'
import type { BrainTidyOperation } from '@shared/brain-tidy'
import { Button } from '@/components/form'
import { TooltipButton } from '@/components/Tooltip'
import { SectionLabel } from '@/features/sessions/SidebarPrimitives'
import { formatCount } from '@/lib/format'
import { relativeTime } from '@/lib/time'
import {
  finishedRead,
  jobsAhead,
  laneKey,
  laneLine,
  readLine,
  type LaneGroup,
  type LaneRow,
  type LaneSelection,
} from './laneGroups'
import { brainLaneTitle } from '../laneTitle'
import { CHANGE_WHO, changeTitle } from './ChangeDetail'

/** Reads by state, then Recent changes; one selectable row each. */
export function LaneList({
  groups,
  jobs,
  changes,
  selected,
  onSelect,
  onUndo,
  busy,
  now,
  extra,
}: {
  groups: LaneGroup[]
  jobs: BrainJob[]
  changes: BrainTidyOperation[]
  selected: LaneSelection | null
  onSelect: (selection: LaneSelection) => void
  onUndo: (operationId: string) => void
  busy: boolean
  now: number
  /** Rows after Recent changes (the lanes Brain never reads). */
  extra?: React.ReactNode
}): React.JSX.Element {
  const key = laneKey(selected)
  const status = useBrain((s) => s.status)!
  const [expanded, setExpanded] = useState(false)
  return (
    <div className="min-w-0 space-y-3 p-2">
      {groups.map((group) => (
        <section key={group.id} aria-label={group.label}>
          <SectionLabel>
            {group.label} · {group.rows.length}
          </SectionLabel>
          <ul>
            {group.rows.slice(0, group.id === 'waiting' && !expanded ? 3 : undefined).map((row) => (
              <li key={row.job.id}>
                <LaneRowButton
                  title={brainLaneTitle(row.job.title)}
                  line={
                    group.id === 'waiting' && brainLaneNeverRead(status.prefs.neverRead, row.job)
                      ? `${formatCount(row.memories, 'memory', 'memories')} · Brain never reads this lane`
                      : rowLine(row, jobs, now)
                  }
                  danger={row.job.state === 'failed'}
                  selected={key === `job:${row.job.id}`}
                  onClick={() => onSelect({ type: 'job', id: row.job.id })}
                />
              </li>
            ))}
          </ul>
          {group.id === 'waiting' && !expanded && group.rows.length > 3 && (
            <Button size="xs" onClick={() => setExpanded(true)}>
              {group.rows.length - 3} more
            </Button>
          )}
        </section>
      ))}
      <RecentChanges
        changes={changes}
        selectedKey={key}
        busy={busy}
        onSelect={onSelect}
        onUndo={onUndo}
      />
      {extra}
    </div>
  )
}

function rowLine(row: LaneRow, jobs: BrainJob[], now: number): string {
  return finishedRead(row.job)
    ? readLine(row, now)
    : laneLine(row.job, now, jobsAhead(jobs, row.job.id))
}

export function LaneRowButton({
  title,
  line,
  selected,
  danger = false,
  onClick,
}: {
  title: string
  line: string
  selected: boolean
  danger?: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <TooltipButton
      tooltip={title}
      aria-current={selected ? 'true' : undefined}
      className="brain-row min-w-0 flex-col gap-0"
      onClick={onClick}
    >
      <span className="block w-full whitespace-normal font-medium">{title}</span>
      <span
        className={
          danger
            ? 'text-danger block w-full whitespace-normal text-sm'
            : 'text-text-tertiary block w-full whitespace-normal text-sm'
        }
      >
        {line}
      </span>
    </TooltipButton>
  )
}

/** The same rows, with the journal's finality and attribution. */
function RecentChanges({
  changes,
  selectedKey,
  busy,
  onSelect,
  onUndo,
}: {
  changes: BrainTidyOperation[]
  selectedKey: string
  busy: boolean
  onSelect: (selection: LaneSelection) => void
  onUndo: (id: string) => void
}): React.JSX.Element | null {
  if (!changes.length) return null
  return (
    <section aria-label="Recent changes">
      <SectionLabel>Recent changes · {changes.length}</SectionLabel>
      <ul>
        {changes.map((change) => (
          <li key={change.id} className="flex items-start gap-1">
            <LaneRowButton
              title={changeTitle(change)}
              line={`${CHANGE_WHO[change.who]} · ${relativeTime(change.createdAt)}${change.undoneAt ? ' · Undone' : change.kind === 'erase' ? ' · can’t be undone' : ''}`}
              selected={selectedKey === `change:${change.id}`}
              onClick={() => onSelect({ type: 'change', id: change.id })}
            />
            {change.undoable && !change.undoneAt && (
              <Button
                size="xs"
                className="mt-1.5 shrink-0"
                disabled={busy}
                tooltip={`Undo: ${change.summary}`}
                onClick={() => onUndo(change.id)}
              >
                Undo
              </Button>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}
