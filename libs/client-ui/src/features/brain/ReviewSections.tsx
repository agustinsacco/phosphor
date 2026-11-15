import { useState } from 'react'
import { BRAIN_MEMORY_TYPES, type BrainProposalView } from '@shared/brain'
import { Button, Select, Tag } from '@/components/form'
import { TooltipSummary } from '@/components/Tooltip'
import { MEMORY_LABELS, MemoryQuotes } from './BrainMemory'

export function ReviewPage({ children }: { children: React.ReactNode[] }): React.JSX.Element {
  const [page, setPage] = useState(0)
  return (
    <>
      <div className="space-y-3">{children.slice(page * 20, (page + 1) * 20)}</div>
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

export function ReviewIdentities({
  proposal,
  overrides,
  onChange,
}: {
  proposal: BrainProposalView
  overrides: Record<string, string>
  onChange: (value: Record<string, string>) => void
}): React.JSX.Element {
  const suggested = (identity: BrainProposalView['identities'][number]): string =>
    identity.decision === 'reuse' && identity.entityId ? identity.entityId : 'new'
  return (
    <section aria-label="Who/what is this?" className="space-y-3">
      <h3 className="font-medium">Who/what is this?</h3>
      <div className="flex gap-2">
        <Button
          size="xs"
          onClick={() =>
            onChange(Object.fromEntries(proposal.identities.map((i) => [i.ref, suggested(i)])))
          }
        >
          Select all suggestions
        </Button>
        <Button
          size="xs"
          onClick={() =>
            onChange(Object.fromEntries(proposal.identities.map((i) => [i.ref, 'new'])))
          }
        >
          Select none · all new
        </Button>
      </div>
      <ReviewPage>
        {proposal.identities.map((identity) => (
          <article key={identity.ref} className="border-border space-y-2 rounded border p-3">
            <p>
              {identity.label} · {identity.kind}{' '}
              <Tag>
                {identity.decision === 'reuse'
                  ? `same as ${identity.candidates.find((c) => c.id === identity.entityId)?.label ?? identity.entityId}`
                  : identity.decision}
              </Tag>{' '}
              {identity.auto && <Tag>auto</Tag>}
            </p>
            <p className="text-text-tertiary text-sm">{identity.reason}</p>
            <Select
              label={`Identity for ${identity.label}`}
              value={overrides[identity.ref] ?? suggested(identity)}
              onChange={(value) => onChange({ ...overrides, [identity.ref]: value })}
              options={[
                { value: 'new', label: 'New entity' },
                ...identity.candidates.map((c) => ({
                  value: c.id,
                  label: `${c.label} · ${c.kind} · ${c.description}`,
                })),
              ]}
            />
          </article>
        ))}
      </ReviewPage>
    </section>
  )
}

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
      <ReviewPage>
        {proposal.groups.map((group) => (
          <label key={group.index} className="border-border block rounded border p-3">
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
  const label = (ref: string): string =>
    proposal.identities.find((i) => i.ref === ref)?.label ?? ref
  return (
    <section aria-label="Proposed memories" className="space-y-3">
      <h3 className="font-medium">Memories</h3>
      <div className="flex gap-2">
        <Button size="xs" onClick={() => onChange(proposal.memories.map((m) => m.index))}>
          Select all memories
        </Button>
        <Button size="xs" onClick={() => onChange([])}>
          Select no memories
        </Button>
      </div>
      {BRAIN_MEMORY_TYPES.map((type) => {
        const memories = proposal.memories.filter((m) => m.type === type)
        return (
          memories.length > 0 && (
            <section key={type} className="space-y-2">
              <h4>
                {MEMORY_LABELS[type]} · {memories.length}
              </h4>
              <ReviewPage>
                {memories.map((memory) => (
                  <article
                    key={memory.index}
                    className="border-border space-y-2 rounded border p-3"
                  >
                    <label className="flex gap-2">
                      <input
                        type="checkbox"
                        checked={selected.includes(memory.index)}
                        onChange={(e) =>
                          onChange(
                            e.target.checked
                              ? [...selected, memory.index]
                              : selected.filter((i) => i !== memory.index),
                          )
                        }
                      />
                      <span>{memory.summary}</span>
                    </label>
                    <Tag>{ACTION[memory.action]}</Tag>
                    {memory.target && (
                      <p className="text-text-secondary text-sm">{memory.target.summary}</p>
                    )}
                    <p className="text-text-tertiary text-sm">{memory.reason}</p>
                    {memory.links.map((link, i) => (
                      <div key={i}>
                        <p>
                          {label(link.subject)} → {link.predicate.replaceAll('_', ' ')} →{' '}
                          {label(link.object)}
                        </p>
                        <blockquote className="text-text-tertiary text-sm">{link.quote}</blockquote>
                      </div>
                    ))}
                    <details>
                      <TooltipSummary>{memory.quotes.length} quotes</TooltipSummary>
                      <MemoryQuotes quotes={memory.quotes} />
                    </details>
                  </article>
                ))}
              </ReviewPage>
            </section>
          )
        )
      })}
    </section>
  )
}
