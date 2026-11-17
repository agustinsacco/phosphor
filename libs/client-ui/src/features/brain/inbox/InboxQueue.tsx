import type { KeyboardEvent } from 'react'
import type { useTidyPage } from '../tidy/useTidyPage'
import { Button } from '@/components/form'
import { TooltipButton } from '@/components/Tooltip'
import { SectionLabel } from '@/features/sessions/SidebarPrimitives'
import { formatCount } from '@/lib/format'
import { tidyLine, tidyTitle } from '../tidy/tidyWording'
import type { InboxGroup, InboxItem } from './inboxItems'

/** Up and Down move focus between rows; j and k move the selection (see BrainInbox). */
function moveFocus(event: KeyboardEvent<HTMLDivElement>): void {
  if (!['ArrowUp', 'ArrowDown'].includes(event.key)) return
  const rows = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[data-inbox-row]')]
  const index = rows.indexOf(document.activeElement as HTMLButtonElement)
  if (index < 0) return
  event.preventDefault()
  rows[
    Math.max(0, Math.min(rows.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))
  ]?.focus()
}

export function InboxQueue({
  groups,
  selected,
  onSelect,
  tidy,
}: {
  groups: InboxGroup[]
  selected: string | null
  onSelect: (key: string) => void
  tidy: ReturnType<typeof useTidyPage>
}): React.JSX.Element {
  const { page, error, loading } = tidy
  const onRetry = (): void => {
    void tidy.reload()
  }
  const onMore = (): void => {
    void tidy.reload(true)
  }
  return (
    <div className="min-w-0 space-y-3 p-2" onKeyDown={moveFocus}>
      {groups.map((group) => (
        <section key={group.id} aria-label={group.label}>
          <SectionLabel>
            {group.label} · {group.total}
          </SectionLabel>
          <ul>
            {group.items.map((item) => (
              <li key={item.key}>
                <QueueRow item={item} selected={item.key === selected} onSelect={onSelect} />
              </li>
            ))}
          </ul>
        </section>
      ))}
      {page?.next && (
        <Button size="sm" disabled={loading} onClick={onMore}>
          {loading ? 'Loading…' : 'Show more suggestions'}
        </Button>
      )}
      {error && (
        <p role="status" className="p-2 text-sm">
          {error}{' '}
          <Button size="xs" onClick={onRetry}>
            Retry
          </Button>
        </p>
      )}
      {!page && !error && (
        <p role="status" className="text-text-tertiary p-2 text-sm">
          Loading suggestions…
        </p>
      )}
      {page && !groups.length && (
        <div className="space-y-1 p-2">
          <p>Nothing to decide.</p>
          <p className="text-text-tertiary text-sm">
            Lane reads to review and Tidy findings land here. Right-click a lane and choose Queue
            for knowledge extraction, or run a check below.
          </p>
        </div>
      )}
      <p className="text-text-tertiary px-2 font-mono text-xs">
        <kbd>j</kbd> <kbd>k</kbd> move · <kbd>a</kbd> approve or apply · <kbd>r</kbd> reject
      </p>
    </div>
  )
}

function QueueRow({
  item,
  selected,
  onSelect,
}: {
  item: InboxItem
  selected: boolean
  onSelect: (key: string) => void
}): React.JSX.Element {
  const title = item.kind === 'review' ? item.job.title : tidyTitle(item.suggestion)
  const line =
    item.kind === 'review'
      ? `${formatCount(item.job.memories, 'memory', 'memories')} to review${item.job.replaces ? ' · read again' : ''}`
      : tidyLine(item.suggestion)
  return (
    <TooltipButton
      data-inbox-row
      tooltip={title}
      aria-current={selected ? 'true' : undefined}
      className="brain-row flex-col gap-0"
      onClick={() => onSelect(item.key)}
    >
      <span className="block w-full truncate font-medium">{title}</span>
      <span className="text-text-tertiary block w-full truncate text-sm">{line}</span>
    </TooltipButton>
  )
}
