import type { KeyboardEvent } from 'react'
import {
  BRAIN_TIDY_KINDS,
  type BrainTidyKind,
  type BrainTidyOperation,
  type BrainTidyPage,
} from '@shared/brain-tidy'
import { TooltipButton } from '@/components/Tooltip'
import { Button } from '@/components/form'
import { SectionLabel } from '@/features/sessions/SidebarPrimitives'
import { relativeTime } from '@/lib/time'

export const TIDY_LABELS: Record<BrainTidyKind, string> = {
  same_entity: 'Same person or thing?',
  same_memory: 'Said twice',
  conflict: 'These disagree',
  flagged: 'Flagged by a lane',
}
export type TidySelection = { type: 'suggestion' | 'operation'; id: string } | null

function moveRow(event: KeyboardEvent<HTMLDivElement>): void {
  if (!['ArrowUp', 'ArrowDown'].includes(event.key)) return
  const rows = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[data-tidy-row]')]
  const index = rows.indexOf(document.activeElement as HTMLButtonElement)
  if (index < 0) return
  event.preventDefault()
  rows[
    Math.max(0, Math.min(rows.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))
  ]?.focus()
}

export function TidyList({
  page,
  changes,
  selected,
  onSelect,
  onMore,
  loading,
  onUndo,
  busy,
}: {
  page: BrainTidyPage | null
  changes: BrainTidyOperation[]
  selected: TidySelection
  onSelect: (selection: TidySelection) => void
  onMore: () => void
  loading: boolean
  onUndo: (id: string) => void
  busy: boolean
}): React.JSX.Element {
  return (
    <div className="min-w-0 space-y-4 p-3 [overflow-wrap:anywhere]" onKeyDown={moveRow}>
      {BRAIN_TIDY_KINDS.map((kind) => {
        const items = page?.items.filter((s) => s.kind === kind) ?? []
        if (!page?.counts[kind]) return null
        return (
          <section key={kind} aria-label={TIDY_LABELS[kind]}>
            <SectionLabel>
              {TIDY_LABELS[kind]} · {page.counts[kind]}
            </SectionLabel>
            <ul>
              {items.map((item) => (
                <li key={item.id}>
                  <TidyRow
                    label={item.subjects.map((s) => s.label).join(' · ')}
                    reason={item.reason}
                    disabled={busy}
                    selected={selected?.type === 'suggestion' && selected.id === item.id}
                    onClick={() => onSelect({ type: 'suggestion', id: item.id })}
                  />
                </li>
              ))}
            </ul>
          </section>
        )
      })}
      {page?.next && (
        <Button disabled={loading} onClick={onMore}>
          {loading ? 'Loading…' : 'Show more'}
        </Button>
      )}
      {!!changes.length && (
        <section aria-label="Recent changes">
          <SectionLabel>Recent changes · {changes.length}</SectionLabel>
          <ul>
            {changes.map((op) => (
              <li key={op.id}>
                <TidyRow
                  label={op.summary}
                  reason={`${op.automatic ? 'Automatic' : 'By you'} · ${relativeTime(op.createdAt)}${op.undoneAt ? ' · Undone' : ''}`}
                  disabled={busy}
                  selected={selected?.type === 'operation' && selected.id === op.id}
                  onClick={() => onSelect({ type: 'operation', id: op.id })}
                />
                {!op.undoneAt && (
                  <Button size="xs" disabled={busy} onClick={() => onUndo(op.id)}>
                    Undo
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
function TidyRow({
  label,
  reason,
  selected,
  disabled,
  onClick,
}: {
  label: string
  reason: string
  selected: boolean
  disabled: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <TooltipButton
      data-tidy-row
      disabled={disabled}
      aria-current={selected ? 'true' : undefined}
      tooltip={label}
      onClick={onClick}
      className={`hover:bg-bg-secondary w-full min-w-0 rounded-md px-2 py-2 text-left [overflow-wrap:anywhere] ${selected ? 'bg-sidebar-active' : ''}`}
    >
      <span className="line-clamp-2 font-medium">{label}</span>
      <span className="text-text-tertiary line-clamp-2 text-sm">{reason}</span>
    </TooltipButton>
  )
}
