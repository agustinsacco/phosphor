import { useState } from 'react'
import { BRAIN_MEMORY_TYPES, type BrainProposalView } from '@shared/brain'
import { Button, Tag } from '@/components/form'
import { TooltipSummary } from '@/components/Tooltip'
import { MEMORY_LABELS, MemoryQuotes } from './BrainMemory'

export function ReviewPage({ children }: { children: React.ReactNode[] }): React.JSX.Element {
  const [page, setPage] = useState(0)
  return (
    <>
      <div className="divide-border divide-y">{children.slice(page * 20, (page + 1) * 20)}</div>
      {children.length > 20 && (
        <div className="flex gap-2">
          <Button size="xs" disabled={!page} onClick={() => setPage(page - 1)}>
            Previous
          </Button>
          <span>
            {page + 1} / {Math.ceil(children.length / 20)}
          </span>
          <Button
            size="xs"
            disabled={(page + 1) * 20 >= children.length}
            onClick={() => setPage(page + 1)}
          >
            Next
          </Button>
        </div>
      )}
    </>
  )
}

export { ReviewIdentities } from './ReviewIdentities'

export function ReviewGroups({
  proposal,
  selected,
  onChange,
}: {
  proposal: BrainProposalView
  selected: number[]
  onChange: (value: number[]) => void
}): React.JSX.Element | null {
  if (!proposal.groups.length) return null
  return (
    <section aria-label="Possible groups" className="space-y-3">
      <h3 className="font-medium">Possible groups</h3>
      <div className="flex gap-2">
        <Button size="xs" onClick={() => onChange(proposal.groups.map((g) => g.index))}>
          Select all groups
        </Button>
        <Button size="xs" onClick={() => onChange([])}>
          Select no groups
        </Button>
      </div>
      <div className="border-border bg-surface rounded-lg border">
        <ReviewPage>
          {proposal.groups.map((group) => (
            <label key={group.index} className="block p-3">
              <input
                type="checkbox"
                checked={selected.includes(group.index)}
                onChange={(e) =>
                  onChange(
                    e.target.checked
                      ? [...selected, group.index]
                      : selected.filter((i) => i !== group.index),
                  )
                }
              />{' '}
              Are these part of one {group.parent.label}?
              <span className="text-text-tertiary block text-sm">
                {group.labels.join(', ')} · unchecked means no
              </span>
            </label>
          ))}
        </ReviewPage>
      </div>
    </section>
  )
}

const ACTION = {
  add: 'new',
  enrich: 'adds link to existing',
  supersede: 'supersedes',
  conflict: 'conflicts',
  resolve_open: 'resolves',
}
export function ReviewMemories({
  proposal,
  selected,
  onChange,
}: {
  proposal: BrainProposalView
  selected: number[]
  onChange: (value: number[]) => void
}): React.JSX.Element {
  return (
    <section aria-label="Proposed memories" className="space-y-3">
      <h3 className="font-medium">
        Memories · {selected.length} of {proposal.memories.length} selected
      </h3>
      {BRAIN_MEMORY_TYPES.map((type) => {
        const memories = proposal.memories.filter((memory) => memory.type === type)
        if (!memories.length) return null
        const count = memories.filter((memory) => selected.includes(memory.index)).length
        return (
          <section key={type} className="border-border bg-surface rounded-lg border">
            <label className="border-border bg-bg-secondary/40 flex items-center gap-2 border-b px-4 py-2">
              <input
                type="checkbox"
                aria-label={`All ${MEMORY_LABELS[type].toLowerCase()}`}
                checked={count === memories.length}
                ref={(node) => {
                  if (node) node.indeterminate = count > 0 && count < memories.length
                }}
                onChange={(event) =>
                  onChange(
                    event.target.checked
                      ? [...new Set([...selected, ...memories.map((memory) => memory.index)])]
                      : selected.filter(
                          (index) => !memories.some((memory) => memory.index === index),
                        ),
                  )
                }
              />
              {MEMORY_LABELS[type]} · {memories.length}
            </label>
            <ReviewPage>
              {memories.map((memory) => (
                <ReviewMemory
                  key={memory.index}
                  memory={memory}
                  proposal={proposal}
                  checked={selected.includes(memory.index)}
                  onChange={(checked) =>
                    onChange(
                      checked
                        ? [...selected, memory.index]
                        : selected.filter((i) => i !== memory.index),
                    )
                  }
                />
              ))}
            </ReviewPage>
          </section>
        )
      })}
    </section>
  )
}
function ReviewMemory({
  memory,
  proposal,
  checked,
  onChange,
}: {
  memory: BrainProposalView['memories'][number]
  proposal: BrainProposalView
  checked: boolean
  onChange: (checked: boolean) => void
}): React.JSX.Element {
  const label = (ref: string): string =>
    proposal.identities.find((i) => i.ref === ref)?.label ?? ref
  return (
    <article className="min-w-0 space-y-2 px-4 py-3">
      <label className="flex items-start gap-2">
        <input
          className="mt-1 shrink-0"
          type="checkbox"
          checked={checked}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span className="min-w-0">{memory.summary}</span>
      </label>
      <Tag>{ACTION[memory.action]}</Tag>
      {memory.target && <p className="text-text-secondary text-sm">{memory.target.summary}</p>}
      <p className="text-text-tertiary text-sm">{memory.reason}</p>
      {memory.links.map((link, index) => (
        <div key={index}>
          <p>
            {label(link.subject)} → {link.predicate.replaceAll('_', ' ')} → {label(link.object)}
          </p>
          <blockquote className="text-text-tertiary text-sm">{link.quote}</blockquote>
        </div>
      ))}
      <details>
        <TooltipSummary>{memory.quotes.length} quotes</TooltipSummary>
        <MemoryQuotes quotes={memory.quotes} />
      </details>
    </article>
  )
}
