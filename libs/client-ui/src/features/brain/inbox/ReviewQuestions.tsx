import { useState } from 'react'
import type { BrainEntity, BrainIdentity, BrainProposalView } from '@shared/brain'
import { Button, Tag } from '@/components/form'
import { TooltipButton } from '@/components/Tooltip'
import { formatCount } from '@/lib/format'
import { ENTITY_WORDS } from '../memoryLabels'
import { useEntityView } from '../explorer/useEntityView'
import {
  differingDescription,
  foldedIdentities,
  identityChoice,
  isRequired,
  questionIdentities,
  type ReviewChoices,
} from './reviewModel'

export function questionCount(proposal: BrainProposalView): number {
  return questionIdentities(proposal).length + proposal.groups.length
}

/** People and things first, one card each; everything Brain is sure of folds into one line. */
export function ReviewQuestions({
  proposal,
  choices,
  onChange,
}: {
  proposal: BrainProposalView
  choices: ReviewChoices
  onChange: (update: (old: ReviewChoices) => ReviewChoices) => void
}): React.JSX.Element {
  const choose = (ref: string, value: string): void =>
    onChange((old) => ({ ...old, identities: { ...old.identities, [ref]: value } }))
  const describe = (ref: string, use: boolean): void =>
    onChange((old) => ({
      ...old,
      descriptions: use
        ? [...new Set([...old.descriptions, ref])]
        : old.descriptions.filter((item) => item !== ref),
    }))
  return (
    <section aria-label="Questions" className="space-y-3">
      {questionIdentities(proposal).map((identity) => (
        <IdentityQuestion
          key={identity.ref}
          identity={identity}
          choices={choices}
          onChoose={(value) => choose(identity.ref, value)}
          onDescribe={(use) => describe(identity.ref, use)}
        />
      ))}
      {proposal.groups.map((group) => {
        const yes = choices.groups.includes(group.index)
        const set = (value: boolean): void =>
          onChange((old) => ({
            ...old,
            groups: value
              ? [...new Set([...old.groups, group.index])]
              : old.groups.filter((index) => index !== group.index),
          }))
        return (
          <QuestionCard key={`group-${group.index}`} label={`Group ${group.parent.label}`}>
            <p className="font-medium">Are these part of one {group.parent.label}?</p>
            <p className="text-text-secondary text-sm">{group.labels.join(', ')}</p>
            <div role="group" aria-label={`Group ${group.parent.label}`} className="flex flex-wrap gap-2">
              <Choice pressed={yes} onClick={() => set(true)}>
                Yes, one {group.parent.label}
              </Choice>
              <Choice pressed={!yes} onClick={() => set(false)}>
                No
              </Choice>
            </div>
          </QuestionCard>
        )
      })}
      <FoldedIdentities proposal={proposal} choices={choices} onDescribe={describe} />
    </section>
  )
}

function QuestionCard({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <article
      aria-label={label}
      className="border-border border-l-accent min-w-0 space-y-2 rounded-lg border border-l-[3px] p-3"
    >
      {children}
    </article>
  )
}

function Choice({
  pressed,
  onClick,
  children,
}: {
  pressed: boolean
  onClick: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <Button size="sm" variant={pressed ? 'primary' : 'secondary'} aria-pressed={pressed} onClick={onClick}>
      {children}
    </Button>
  )
}

function IdentityQuestion({
  identity,
  choices,
  onChoose,
  onDescribe,
}: {
  identity: BrainIdentity
  choices: ReviewChoices
  onChoose: (value: string) => void
  onDescribe: (use: boolean) => void
}): React.JSX.Element {
  const value = identityChoice(identity, choices.identities)
  const [first, ...others] = identity.candidates
  const shown = identity.candidates.find((candidate) => candidate.id === value) ?? first
  const existing = differingDescription(identity, choices.identities)
  return (
    <QuestionCard label={`Who is ${identity.label}?`}>
      <p className="flex flex-wrap items-center gap-2">
        <span className="font-medium">
          Is “{identity.label}” in this lane {first?.label ?? 'someone Brain knows'}?
        </span>
        {isRequired(identity) && !choices.identities[identity.ref] && (
          <Tag className="bg-accent-soft text-accent">Needs an answer</Tag>
        )}
      </p>
      {identity.reason && <p className="text-text-tertiary text-sm">{identity.reason}</p>}
      {shown && <CandidateFacts candidate={shown} />}
      <div role="group" aria-label={`Identity for ${identity.label}`} className="flex flex-wrap gap-2">
        {first && (
          <Choice pressed={value === first.id} onClick={() => onChoose(first.id)}>
            Yes, {first.label}
          </Choice>
        )}
        <Choice pressed={value === 'new'} onClick={() => onChoose('new')}>
          {identity.kind === 'person' ? 'Someone new' : 'Something new'}
        </Choice>
        {others.map((candidate) => (
          <Choice key={candidate.id} pressed={value === candidate.id} onClick={() => onChoose(candidate.id)}>
            {candidate.label} · {ENTITY_WORDS[candidate.kind]}
          </Choice>
        ))}
      </div>
      {existing && (
        <DescriptionChoice
          identity={identity}
          existing={existing}
          checked={choices.descriptions.includes(identity.ref)}
          onChange={onDescribe}
        />
      )}
    </QuestionCard>
  )
}

/** What Brain already holds about a candidate, so the answer is not a guess from a name. */
function CandidateFacts({ candidate }: { candidate: BrainEntity }): React.JSX.Element {
  const { data, error, retry } = useEntityView(candidate.id)
  return (
    <p className="text-text-secondary text-sm">
      {candidate.label} · {ENTITY_WORDS[candidate.kind]}
      {candidate.description && `: ${candidate.description}`}{' '}
      <span className="text-text-tertiary">
        {data
          ? `· ${formatCount(data.entity.memories, 'memory', 'memories')} · ${formatCount(data.entity.connections, 'link')}`
          : error
            ? '· counts unavailable'
            : '· counting…'}
      </span>
      {error && (
        <Button size="xs" className="ml-2" onClick={retry}>
          Retry
        </Button>
      )}
    </p>
  )
}

export function DescriptionChoice({
  identity,
  existing,
  checked,
  onChange,
}: {
  identity: BrainIdentity
  existing: BrainEntity
  checked: boolean
  onChange: (use: boolean) => void
}): React.JSX.Element {
  return (
    <div className="bg-bg-secondary/60 space-y-1 rounded-md p-2 text-sm">
      <p>
        <span className="text-text-tertiary">Brain has: </span>
        {existing.description || 'No description'}
      </p>
      <p>
        <span className="text-text-tertiary">This read says: </span>
        {identity.description}
      </p>
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
        Use this read’s description for {existing.label}
      </label>
    </div>
  )
}

function FoldedIdentities({
  proposal,
  choices,
  onDescribe,
}: {
  proposal: BrainProposalView
  choices: ReviewChoices
  onDescribe: (ref: string, use: boolean) => void
}): React.JSX.Element | null {
  const [open, setOpen] = useState(false)
  const folded = foldedIdentities(proposal)
  const confirmations = proposal.confirmations.length
  const differing = folded.flatMap((identity) => {
    const existing = differingDescription(identity, choices.identities)
    return existing ? [{ identity, existing }] : []
  })
  if (!folded.length && !confirmations) return null
  const line = [
    folded.length &&
      `${formatCount(folded.length, 'person or thing', 'people and things')} matched without doubt`,
    confirmations &&
      `${formatCount(confirmations, 'memory confirms', 'memories confirm')} what Brain knows`,
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <div className="space-y-2">
      <TooltipButton
        aria-expanded={open}
        className="text-text-tertiary hover:text-text text-left text-sm"
        onClick={() => setOpen(!open)}
      >
        {open ? '▾' : '▸'} {line}
      </TooltipButton>
      {differing.map(({ identity, existing }) => (
        <DescriptionChoice
          key={identity.ref}
          identity={identity}
          existing={existing}
          checked={choices.descriptions.includes(identity.ref)}
          onChange={(use) => onDescribe(identity.ref, use)}
        />
      ))}
      {open && (
        <ul className="text-text-secondary space-y-1 pl-4 text-sm">
          {folded.map((identity) => (
            <li key={identity.ref}>
              {identity.label} · {ENTITY_WORDS[identity.kind]} ·{' '}
              {identity.decision === 'reuse' ? 'already known' : 'new'}
            </li>
          ))}
          {proposal.confirmations.map((item) => (
            <li key={item.id}>Confirms: {item.summary}</li>
          ))}
        </ul>
      )}
    </div>
  )
}
