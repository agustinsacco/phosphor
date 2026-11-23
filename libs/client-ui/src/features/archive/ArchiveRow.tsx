import { Button, Tag } from '@/components/form'
import { tooltipProps } from '@/components/Tooltip'
import { SelectBox, type LaneSelect } from '../sessions/LaneSelect'
import { absoluteTime, relativeTime } from '@/lib/time'
import type { LaneArchiveEntry } from '@phosphor/shared/lane-archive'

/**
 * One archived lane. The row keeps its own Restore and Clean up so a single
 * archive needs no trip through select mode; the bulk bar is for the many.
 */
export function ArchiveRow({
  entry,
  select,
  busy,
  canRestore,
  canPurge,
  onRestore,
  onPurge,
}: {
  entry: LaneArchiveEntry
  select: LaneSelect
  /** Which operation this row is running. Only that button changes its label. */
  busy: 'restore' | 'purge' | null
  canRestore: boolean
  canPurge: boolean
  onRestore: () => void
  onPurge: () => void
}): React.JSX.Element {
  return (
    <li data-testid="archive-row" className="group flex items-center gap-3 py-3">
      <SelectBox select={select} />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <h3 className="truncate font-medium">{entry.title}</h3>
          {entry.state !== 'archived' && (
            <Tag className="bg-warning/15 text-warning">{entry.state}</Tag>
          )}
        </div>
        <p className="text-text-tertiary truncate text-xs" {...tooltipProps(entry.cwd)}>
          {entry.cwd}
        </p>
        <p className="text-text-tertiary text-xs" {...tooltipProps(absoluteTime(entry.archivedAt))}>
          {relativeTime(entry.archivedAt)}
        </p>
      </div>
      <Button size="sm" disabled={!canRestore} onClick={onRestore}>
        {busy === 'restore' ? 'Restoring…' : 'Restore'}
      </Button>
      <Button size="sm" variant="danger" disabled={!canPurge} onClick={onPurge}>
        {busy === 'purge'
          ? 'Cleaning up…'
          : entry.state === 'purging'
            ? 'Retry cleanup…'
            : 'Clean up…'}
      </Button>
    </li>
  )
}
