import { useId, useState } from 'react'
import type { BrainProposalView } from '@shared/brain'
import { Button } from '@/components/form'
import { TooltipSummary } from '@/components/Tooltip'
import { formatCount } from '@/lib/format'
import { SectionLabel } from '@/features/sessions/SidebarPrimitives'
import { MEMORY_TYPE_WORDS } from '../memoryLabels'
import { MemoryQuotes } from '../MemoryQuotes'
import {
  checklistGroups,
  checklistTotal,
  isTicked,
  memoryNames,
  refLabel,
  setTicked,
  tickCount,
  type ChecklistGroup,
  type ChecklistItem,
  type ReviewChoices,
} from './reviewModel'

const PAGE = 20

type ChoicesUpdate = (update: (old: ReviewChoices) => ReviewChoices) => void

/**
 * Memories as a checklist by type; held claims, and held confirmations of what Brain knows,
 * come last and start unticked.
 */
export function ReviewChecklist({
  proposal,
  choices,
  onChange,
}: {
  proposal: BrainProposalView
  choices: ReviewChoices
  onChange: ChoicesUpdate
}): React.JSX.Element | null {
  const total = checklistTotal(proposal)
  if (!total) return null
  return (
    <section aria-label="Proposed memories" className="space-y-1">
      <SectionLabel>
        Memories · {tickCount(choices)} of {total} ticked
      </SectionLabel>
      {checklistGroups(proposal).map((group) => (
        <ChecklistSection
          key={group.id}
          group={group}
          proposal={proposal}
          choices={choices}
          onChange={onChange}
        />
      ))}
    </section>
  )
}

function ChecklistSection({
  group,
  proposal,
  choices,
  onChange,
}: {
  group: ChecklistGroup
  proposal: BrainProposalView
  choices: ReviewChoices
  onChange: ChoicesUpdate
}): React.JSX.Element {
  const [page, setPage] = useState(0)
  const { items } = group
  const ticked = items.filter((item) => isTicked(choices, item)).length
  const shown = items.slice(page * PAGE, (page + 1) * PAGE)
  return (
    <section aria-label={group.label} className="pt-2">
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          aria-label={`Keep all: ${group.label}`}
          checked={ticked === items.length}
          ref={(node) => {
            if (node) node.indeterminate = ticked > 0 && ticked < items.length
          }}
          onChange={(event) => {
            const value = event.target.checked
            onChange((old) => setTicked(old, items, value))
          }}
        />
        <span className="text-text-tertiary font-mono text-xs font-semibold tracking-wider uppercase">
          {group.label} · {items.length}
        </span>
      </label>
      {group.held && <p className="text-text-tertiary pl-6 text-sm">Not kept unless you tick it</p>}
      <ul className="divide-border divide-y">
        {shown.map((item) => (
          <li key={item.key}>
            <ChecklistRow
              item={item}
              proposal={proposal}
              checked={isTicked(choices, item)}
              onChange={(checked) => onChange((old) => setTicked(old, [item], checked))}
            />
          </li>
        ))}
      </ul>
      {items.length > PAGE && (
        <div className="flex items-center gap-2 pl-6 text-sm">
          <Button size="xs" disabled={!page} onClick={() => setPage(page - 1)}>
            Previous
          </Button>
          <span>
            {page + 1} / {Math.ceil(items.length / PAGE)}
          </span>
          <Button
            size="xs"
            disabled={(page + 1) * PAGE >= items.length}
            onClick={() => setPage(page + 1)}
          >
            Next
          </Button>
        </div>
      )}
    </section>
  )
}

function ChecklistRow({
  item,
  proposal,
  checked,
  onChange,
}: {
  item: ChecklistItem
  proposal: BrainProposalView
  checked: boolean
  onChange: (checked: boolean) => void
}): React.JSX.Element {
  const { claim: memory, change } = item
  const names = memoryNames(proposal, memory)
  const id = useId()
  const label = (ref: string): string => refLabel(proposal, ref) ?? 'someone Brain knows'
  return (
    <div className="grid grid-cols-[1.25rem_minmax(0,1fr)] gap-1 py-2">
      <input
        id={id}
        type="checkbox"
        className="mt-1 self-start"
        aria-label={`Keep: ${memory.summary}`}
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <div className="brain-type min-w-0">
        <span className="brain-type-label">{MEMORY_TYPE_WORDS[memory.type]}</span>
        <div className="min-w-0 space-y-0.5">
          <label htmlFor={id} className="block cursor-pointer">
            {memory.summary}
          </label>
          {names.length > 0 && <p className="text-text-tertiary text-sm">{names.join(', ')}</p>}
          {change && <p className="text-text-secondary text-sm">{change}</p>}
          {memory.links.map((link, index) => (
            <p key={index} className="text-text-tertiary text-sm">
              {label(link.subject)} → {link.predicate.replaceAll('_', ' ')} → {label(link.object)}
            </p>
          ))}
          {memory.quotes.length > 0 && (
            <details className="text-sm">
              <TooltipSummary className="text-text-tertiary cursor-pointer">
                {formatCount(memory.quotes.length, 'quote')}
              </TooltipSummary>
              <MemoryQuotes quotes={memory.quotes} />
            </details>
          )}
        </div>
      </div>
    </div>
  )
}
