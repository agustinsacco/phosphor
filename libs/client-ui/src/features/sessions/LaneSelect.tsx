import clsx from 'clsx'
import { TooltipButton } from '@/components/Tooltip'
import { SessionIndicator } from './SidebarPrimitives'

/** A row's part in its group's selection. */
export interface LaneSelect {
  title: string
  selected: boolean
  /** The row's group has an active selection. */
  selecting: boolean
  onToggle: (shiftKey: boolean) => void
  /** Why this lane cannot be selected; shown instead of a working box. */
  blocked?: string
}

/**
 * The row's indicator gutter: the state dot, or the select box in the SAME
 * place, so entering select mode shifts nothing. The box is revealed on hover,
 * or whenever the group already has a selection: a permanent column would
 * cost every row 20px forever for a rare action. Rows that cannot join a
 * selection (the Pinned list mixes folders) pass no `select`.
 */
export function SelectableIndicator({
  state,
  select,
}: {
  state: React.ComponentProps<typeof SessionIndicator>['state']
  select?: LaneSelect
}): React.JSX.Element {
  return (
    <>
      {select && <SelectBox select={select} />}
      <span className={clsx(select && (select.selecting ? 'hidden' : 'group-hover:hidden'))}>
        <SessionIndicator state={state} />
      </span>
    </>
  )
}

function SelectBox({ select }: { select: LaneSelect }): React.JSX.Element {
  const { title, selected, selecting, blocked } = select
  return (
    <span
      role="checkbox"
      aria-checked={selected}
      aria-disabled={blocked ? true : undefined}
      aria-label={`Select ${title}`}
      tabIndex={-1}
      onClick={(event) => {
        event.stopPropagation()
        if (!blocked) select.onToggle(event.shiftKey)
      }}
      className={clsx(
        'grid size-5 shrink-0 place-items-center rounded-[4px] border text-2xs',
        selected ? 'bg-accent border-accent text-accent-text' : 'border-border-strong bg-surface',
        blocked && 'cursor-not-allowed opacity-40',
        !selected && !selecting && 'hidden group-hover:grid',
      )}
      data-tooltip={blocked ?? `Select ${title}`}
    >
      {selected ? '✓' : ''}
    </span>
  )
}

/**
 * The bulk bar: only in select mode, so it costs no pixels the rest of the
 * time. It floats over the list rather than adding a permanent toolbar row;
 * `className` places it in the list that owns the selection. Select mode can
 * hold nothing yet ("Select merged lanes" with none merged), so Delete waits
 * for a lane.
 */
export function LaneBulkBar({
  count,
  running,
  className,
  onDelete,
  onCancel,
}: {
  count: number
  running: boolean
  className: string
  onDelete: () => void
  onCancel: () => void
}): React.JSX.Element {
  return (
    <div
      data-testid="bulk-bar"
      className={clsx(
        'bg-surface-raised border-border-strong z-20 flex items-center gap-2 rounded-lg border px-2.5 py-2 shadow-lg',
        className,
      )}
    >
      <span className="text-sm font-semibold">{count} selected</span>
      <span className="flex-1" />
      <TooltipButton
        onClick={onDelete}
        disabled={running || count === 0}
        className="bg-danger rounded-md px-2.5 py-1 text-xs font-semibold text-white disabled:cursor-not-allowed disabled:opacity-40"
      >
        {running ? 'Delete in progress' : 'Delete…'}
      </TooltipButton>
      <TooltipButton
        onClick={onCancel}
        className="border-border text-text-secondary hover:text-text rounded-md border px-2.5 py-1 text-xs"
      >
        Cancel
      </TooltipButton>
    </div>
  )
}
