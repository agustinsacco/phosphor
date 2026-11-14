import { useState } from 'react'
import clsx from 'clsx'
import type { GhPrDetail, GhPrSummary } from '@shared/models'
import type { PrHandoff } from '../prHandoff'
import { groupChecks, inspectorChecks } from './checkGroups'
import { prChecklist, type ChecklistId, type ChecklistRow } from './checklistRows'
import { ActionButton, LinkButton } from './PrBits'
import { CheckList } from './PrChecksTab'
import { PrGlyph } from './PrIcons'
import { PrPeople, PrThreadsTab } from './PrPeopleTabs'

const ICON: Record<ChecklistRow['tone'], Parameters<typeof PrGlyph>[0]['glyph']> = {
  ok: 'check',
  bad: 'x',
  warn: 'pending',
  wait: 'pending',
}
const ROW_ICON: Partial<
  Record<`${ChecklistId}:${ChecklistRow['tone']}`, Parameters<typeof PrGlyph>[0]['glyph']>
> = {
  'review:warn': 'changes',
  'threads:warn': 'comment',
  'branch:bad': 'alert',
  'merge:ok': 'check2',
}
const TONE: Record<ChecklistRow['tone'], string> = {
  ok: 'text-success',
  bad: 'text-danger',
  warn: 'text-warning',
  wait: 'text-text-tertiary',
}

/**
 * What is left before this PR can merge. Each gate's button drafts the
 * hand-off for the lane's agent; nothing is sent or written to GitHub.
 */
export function PrChecklist({
  summary,
  detail,
  loading,
  onHandoff,
  onOpen,
}: {
  summary: GhPrSummary
  detail: GhPrDetail | undefined
  loading: boolean
  onHandoff: (kind: PrHandoff) => void
  onOpen: (url: string) => void
}): React.JSX.Element {
  const [open, setOpen] = useState<ChecklistId | null>(null)
  const rows = prChecklist(summary, detail)
  const sub = (id: ChecklistId) => {
    if (id === 'checks') {
      const { checks, truncated } = inspectorChecks(summary, detail)
      return <CheckList groups={groupChecks(checks, truncated)} onOpen={onOpen} />
    }
    if (id === 'review') return <PrPeople summary={summary} detail={detail} wrap />
    return (
      <PrThreadsTab summary={summary} detail={detail} loading={loading} limit={4} onOpen={onOpen} />
    )
  }
  return (
    <ul aria-label="Merge checklist" data-testid="pr-checklist">
      {rows.map((row) => (
        <li key={row.id} data-testid={`pr-checklist-${row.id}`} data-tone={row.tone}>
          <div className="flex items-start gap-2 rounded-md px-1 py-1.5">
            <span className={clsx('mt-px', TONE[row.tone])}>
              <PrGlyph glyph={ROW_ICON[`${row.id}:${row.tone}`] ?? ICON[row.tone]} size={14} />
            </span>
            <span className="text-text-secondary w-[88px] shrink-0 text-base">{row.label}</span>
            <span className="min-w-0 flex-1 text-base leading-snug">
              {row.text}
              {row.expandable && (
                <>
                  {' '}
                  <LinkButton
                    onClick={() => setOpen(open === row.id ? null : row.id)}
                    expanded={open === row.id}
                    label={`${open === row.id ? 'Hide' : 'Show'} ${row.label.toLowerCase()} details`}
                  >
                    {open === row.id ? 'hide' : 'details'}
                  </LinkButton>
                </>
              )}
            </span>
            {row.action && (
              <ActionButton
                primary={row.action.kind !== 'open'}
                onClick={() =>
                  row.action!.kind === 'open' ? onOpen(summary.url) : onHandoff(row.action!.kind)
                }
                tooltip={
                  row.action.kind === 'open' ? 'Open on GitHub' : 'Draft a message for the agent'
                }
              >
                {row.action.label}
              </ActionButton>
            )}
          </div>
          {open === row.id && (
            <div className="border-border mb-1 ml-[30px] border-l pl-2">{sub(row.id)}</div>
          )}
        </li>
      ))}
    </ul>
  )
}
