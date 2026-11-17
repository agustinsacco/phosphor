import clsx from 'clsx'
import { Panel, PanelGroup, PanelResizeHandle } from 'react-resizable-panels'
import { Button } from '@/components/form'
import { usePlatform } from '@/platform/Platform'

/**
 * A list beside its detail, or on a phone one at a time: the list until an item
 * is open, then the detail with a way back to the list. Layout only, so the
 * features inside never read the form factor.
 */
export function ListDetail({
  listLabel,
  detailLabel,
  list,
  detail,
  open,
  onBack,
  backLabel,
}: {
  listLabel: string
  detailLabel: string
  list: React.ReactNode
  /** The detail. `back` returns a phone to the list while an item is open; otherwise null. */
  detail: (back: React.ReactNode) => React.ReactNode
  /** An item is open, so a phone shows the detail in place of the list. */
  open: boolean
  onBack: () => void
  /** What Back returns to, e.g. "Files". */
  backLabel: string
}): React.JSX.Element {
  const stacked = usePlatform().formFactor === 'compact'
  return (
    <div className={clsx('flex min-h-0 flex-1 gap-4', stacked && 'flex-col')}>
      {(!stacked || !open) && (
        <nav
          aria-label={listLabel}
          className={clsx(
            'border-border bg-bg-secondary/40 overflow-auto',
            stacked ? 'flex-1' : 'w-1/3 border-r',
          )}
        >
          {list}
        </nav>
      )}
      <div aria-label={detailLabel} className="min-w-0 flex-1 overflow-hidden">
        {detail(stacked && open ? <Button onClick={onBack}>← {backLabel}</Button> : null)}
      </div>
    </div>
  )
}

/**
 * A list beside its detail in resizable panels, or on a phone one at a time, as `ListDetail`.
 * A phone keeps the list mounted, hidden, while the detail shows, so going back finds it as
 * it was and does not read it again.
 */
export function SplitListDetail({
  autoSaveId,
  list,
  detail,
  open,
  onBack,
  backLabel,
}: {
  /** Where the panel sizes persist. */
  autoSaveId: string
  list: React.ReactNode
  /** The detail. `back` returns a phone to the list while an item is open; otherwise null. */
  detail: (back: React.ReactNode) => React.ReactNode
  /** An item is open, so a phone shows the detail in place of the list. */
  open: boolean
  onBack: () => void
  /** What Back returns to, e.g. "Files". */
  backLabel: string
}): React.JSX.Element {
  if (usePlatform().formFactor === 'compact')
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div hidden={open} className="bg-bg-secondary/40 min-h-0 flex-1">
          {list}
        </div>
        {open && (
          <div className="min-h-0 flex-1">
            {detail(<Button onClick={onBack}>← {backLabel}</Button>)}
          </div>
        )}
      </div>
    )
  return (
    <PanelGroup direction="horizontal" autoSaveId={autoSaveId}>
      <Panel defaultSize={32} minSize={16} className="bg-bg-secondary/40">
        {list}
      </Panel>
      <PanelResizeHandle className="pane-handle" />
      <Panel minSize={30}>{detail(null)}</Panel>
    </PanelGroup>
  )
}
