import { forwardRef, useCallback, useState } from 'react'
import type { BrainTidyOperation } from '@shared/brain-tidy'
import { ipcErrorText } from '@shared/errors'
import { Button } from '@/components/form'
import { SectionLabel } from '@/features/sessions/SidebarPrimitives'
import { formatCount } from '@/lib/format'
import { relativeTime } from '@/lib/time'
import { brainToast, mutateBrain } from '../useBrain'
import { useBrainResource } from '../useBrainResource'
import { CHANGE_WHO, changeRows, changeTitle, readTitle, type ChangeRow } from './changeRows'
import { useTidyActions } from './useTidyActions'

const SHOWN = 6

/**
 * Saved reads, automatic heals and Brain Agent's changes, newest first: who, when, why, and
 * Undo. A run's changes share one row with Undo run; a read opens how it was read.
 */
export const WhatChanged = forwardRef<
  HTMLElement,
  { onOpenRead: (jobId: string, title: string) => void }
>(function WhatChanged({ onOpenRead }, ref) {
  const load = useCallback(() => window.phosphor.invoke('brain:tidyChanges', 50), [])
  const { data, error, retry } = useBrainResource(load)
  const actions = useTidyActions(retry)
  const [all, setAll] = useState(false)
  const rows = data ? changeRows(data.items) : []
  return (
    <section ref={ref} tabIndex={-1} aria-label="What changed" className="brain-changes">
      <SectionLabel>What changed</SectionLabel>
      {!data ? (
        <p role="status" className="text-sm">
          {error || 'Loading changes…'}{' '}
          {error && (
            <Button size="xs" onClick={retry}>
              Retry
            </Button>
          )}
        </p>
      ) : !rows.length ? (
        <p className="text-text-tertiary text-sm">Nothing changed yet.</p>
      ) : (
        <ul className="divide-border divide-y">
          {rows
            .slice(0, all ? undefined : SHOWN)
            .map((row) =>
              row.type === 'run' ? (
                <RunRow key={row.runId} row={row} busy={actions.busy} onUndone={retry} />
              ) : (
                <ChangeLine
                  key={row.change.id}
                  change={row.change}
                  busy={actions.busy}
                  onUndo={() => actions.undo(row.change.id, data.revision)}
                  onOpenRead={onOpenRead}
                />
              ),
            )}
        </ul>
      )}
      {rows.length > SHOWN && (
        <Button size="xs" onClick={() => setAll(!all)}>
          {all ? 'Show fewer' : `Show ${rows.length - SHOWN} more`}
        </Button>
      )}
      {actions.message && (
        <p role="alert" className="text-danger text-sm">
          {actions.message}
        </p>
      )}
    </section>
  )
})

function whenWords(change: BrainTidyOperation): string {
  return [
    CHANGE_WHO[change.who],
    relativeTime(change.createdAt),
    change.undoneAt ? 'undone' : change.kind === 'erase' ? 'can’t be undone' : '',
  ]
    .filter(Boolean)
    .join(' · ')
}

export function ChangeLine({
  change,
  busy,
  onUndo,
  onOpenRead,
}: {
  change: BrainTidyOperation
  busy: boolean
  onUndo?: () => void
  onOpenRead?: (jobId: string, title: string) => void
}): React.JSX.Element {
  const title = readTitle(change)
  return (
    <li className="flex flex-wrap items-start gap-x-2 gap-y-1 py-1.5">
      <div className="min-w-0 flex-1 [overflow-wrap:anywhere]">
        <p className={change.undoneAt ? 'text-text-tertiary line-through' : ''}>
          {changeTitle(change)}
        </p>
        <p className="text-text-tertiary text-xs">{whenWords(change)}</p>
        {change.reason && change.kind !== 'erase' && (
          <p className="text-text-secondary text-sm">{change.reason}</p>
        )}
      </div>
      {change.kind === 'read' && change.jobId && onOpenRead && (
        <Button size="xs" onClick={() => onOpenRead(change.jobId!, title)}>
          How {title} was read
        </Button>
      )}
      {onUndo && change.undoable && !change.undoneAt && (
        <Button size="xs" disabled={busy} tooltip={`Undo: ${change.summary}`} onClick={onUndo}>
          Undo
        </Button>
      )}
    </li>
  )
}

function RunRow({
  row,
  busy,
  onUndone,
}: {
  row: Extract<ChangeRow, { type: 'run' }>
  busy: boolean
  onUndone: () => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)
  const newest = row.changes[0]!
  const undoable = row.changes.some((change) => change.undoable && !change.undoneAt)
  const undoRun = async (): Promise<void> => {
    setPending(true)
    try {
      const result = await mutateBrain(() => window.phosphor.invoke('brain:undoRun', row.runId))
      brainToast(
        `Undid ${formatCount(result.undone, 'change')}.${result.kept ? ` ${formatCount(result.kept, 'stays', 'stay')}: erasures, and changes later edits use.` : ''}`,
      )
      onUndone()
    } catch (cause) {
      brainToast(ipcErrorText(cause), 'error')
    } finally {
      setPending(false)
    }
  }
  return (
    <li className="py-1.5">
      <div className="flex flex-wrap items-start gap-x-2 gap-y-1">
        <div className="min-w-0 flex-1">
          <p>
            {newest.who === 'automatic' ? 'Automatic heal' : 'Brain Agent run'} ·{' '}
            {formatCount(row.changes.length, 'change')}
          </p>
          <p className="text-text-tertiary text-xs">{relativeTime(newest.createdAt)}</p>
        </div>
        {row.changes.length > 1 && (
          <Button size="xs" aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? 'Hide' : 'Show'}
          </Button>
        )}
        {undoable && (
          <Button
            size="xs"
            disabled={busy || pending}
            onClick={() => {
              void undoRun()
            }}
          >
            Undo run
          </Button>
        )}
      </div>
      {(open || row.changes.length === 1) && (
        <ul className="border-border mt-1 ml-2 border-l pl-2">
          {row.changes.map((change) => (
            <ChangeLine key={change.id} change={change} busy={busy} />
          ))}
        </ul>
      )}
    </li>
  )
}
