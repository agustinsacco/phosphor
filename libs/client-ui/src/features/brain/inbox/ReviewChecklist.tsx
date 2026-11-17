import { useId, useState } from 'react'
import type { BrainProposalView, BrainProposedMemory } from '@shared/brain'
import { Button } from '@/components/form'
import { TooltipSummary } from '@/components/Tooltip'
import { formatCount } from '@/lib/format'
import { SectionLabel } from '@/features/sessions/SidebarPrimitives'
import { MEMORY_TYPE_WORDS } from '../memoryLabels'
import { MemoryQuotes } from '../MemoryQuotes'
import {
  checklistGroups,
  memoryChange,
  memoryNames,
  refLabel,
  type ChecklistGroup,
} from './reviewModel'

const PAGE = 20

/** Memories as a checklist by type; held claims come last and start unticked. */
export function ReviewChecklist({
  proposal,
  keep,
  onChange,
}: {
  proposal: BrainProposalView
  keep: number[]
  onChange: (keep: number[]) => void
}): React.JSX.Element | null {
  if (!proposal.memories.length) return null
  return (
    <section aria-label="Proposed memories" className="space-y-1">
      <SectionLabel>
        Memories · {keep.length} of {proposal.memories.length} ticked
      </SectionLabel>
      {checklistGroups(proposal).map((group) => (
        <ChecklistSection
          key={group.id}
          group={group}
          proposal={proposal}
          keep={keep}
          onChange={onChange}
        />
      ))}
    </section>
  )
}

function ChecklistSection({
  group,
  proposal,
  keep,
  onChange,
}: {
  group: ChecklistGroup
  proposal: BrainProposalView
  keep: number[]
  onChange: (keep: number[]) => void
}): React.JSX.Element {
  const [page, setPage] = useState(0)
  const indexes = group.memories.map((memory) => memory.index)
  const ticked = indexes.filter((index) => keep.includes(index)).length
  const shown = group.memories.slice(page * PAGE, (page + 1) * PAGE)
  return (
    <section aria-label={group.label} className="pt-2">
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          aria-label={`Keep all: ${group.label}`}
          checked={ticked === indexes.length}
          ref={(node) => {
            if (node) node.indeterminate = ticked > 0 && ticked < indexes.length
          }}
          onChange={(event) =>
            onChange(
              event.target.checked
                ? [...new Set([...keep, ...indexes])]
                : keep.filter((index) => !indexes.includes(index)),
            )
          }
        />
        <span className="text-text-tertiary font-mono text-xs font-semibold tracking-wider uppercase">
          {group.label} · {group.memories.length}
        </span>
      </label>
      {group.held && <p className="text-text-tertiary pl-6 text-sm">Not kept unless you tick it</p>}
      <ul className="divide-border divide-y">
        {shown.map((memory) => (
          <li key={memory.index}>
            <ChecklistRow
              memory={memory}
              proposal={proposal}
              checked={keep.includes(memory.index)}
              onChange={(checked) =>
                onChange(checked ? [...keep, memory.index] : keep.filter((i) => i !== memory.index))
              }
            />
          </li>
        ))}
      </ul>
      {group.memories.length > PAGE && (
        <div className="flex items-center gap-2 pl-6 text-sm">
          <Button size="xs" disabled={!page} onClick={() => setPage(page - 1)}>
            Previous
          </Button>
          <span>
            {page + 1} / {Math.ceil(group.memories.length / PAGE)}
          </span>
          <Button
            size="xs"
            disabled={(page + 1) * PAGE >= group.memories.length}
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
  memory,
  proposal,
  checked,
  onChange,
}: {
  memory: BrainProposedMemory
  proposal: BrainProposalView
  checked: boolean
  onChange: (checked: boolean) => void
}): React.JSX.Element {
  const names = memoryNames(proposal, memory)
  const change = memoryChange(memory)
  const id = useId()
  const label = (ref: string): string => refLabel(proposal, ref) ?? 'someone Brain knows'
  return (
    <div className="grid grid-cols-[1.25rem_minmax(0,1fr)] gap-1 py-2">
      <input
        id={id}
        type="checkbox"
        className="mt-1"
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
