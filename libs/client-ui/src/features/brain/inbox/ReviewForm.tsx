import { useEffect, useState } from 'react'
import type { BrainProposalView } from '@shared/brain'
import { Button } from '@/components/form'
import { TooltipButton } from '@/components/Tooltip'
import { formatCount } from '@/lib/format'
import { brainToast, useBrain } from '../useBrain'
import { useBrainModelName } from '../useBrainModelName'
import { DecisionBar, DecisionFrame, type DecisionKeys } from './DecisionFrame'
import { ReviewQuestions, questionCount } from './ReviewQuestions'
import { ReviewChecklist } from './ReviewChecklist'
import {
  approveBlock,
  approveLabel,
  initialChoices,
  reviewDecision,
  type ReviewChoices,
} from './reviewModel'

export function ReviewForm({
  proposal,
  keys,
  onExtraction,
  onStale,
}: {
  proposal: BrainProposalView
  keys: React.RefObject<DecisionKeys>
  onExtraction: () => void
  onStale: () => Promise<void>
}): React.JSX.Element {
  const { job } = proposal
  const [choices, setChoices] = useState<ReviewChoices>(() => initialChoices(proposal))
  const saving = useBrain((s) => s.saving)
  const model = useBrainModelName(job.model)
  const [error, setError] = useState('')
  const block = approveBlock(proposal, choices)
  const neverRead = false
  const submit = async (approve: boolean): Promise<void> => {
    if (approve && block) return
    setError('')
    const decision = approve ? reviewDecision(proposal, choices) : null
    if (await useBrain.getState().review(job.id, decision, proposal.revision))
      brainToast(
        approve
          ? `Approved ${formatCount(decision!.memories.length, 'memory', 'memories')} from ${job.title}`
          : `Rejected the read of ${job.title}`,
      )
    else {
      const message = useBrain.getState().error
      setError(message)
      if (message.startsWith('Brain changed')) await onStale()
    }
  }
  const approve = (): void => {
    void submit(true)
  }
  const reject = (): void => {
    void submit(false)
  }
  useEffect(() => {
    keys.current = { primary: neverRead ? reject : approve, reject }
  })
  const questions = questionCount(proposal)
  return (
    <DecisionFrame
      label="Review memories"
      eyebrow="From lanes"
      title={job.title}
      subtitle={`${formatCount(proposal.memories.length, 'memory', 'memories')}${questions ? ` · ${formatCount(questions, 'question')}` : ''} · read by ${model}`}
      aside={
        <TooltipButton
          className="text-text-secondary hover:text-text text-sm underline"
          onClick={onExtraction}
        >
          See how it was read
        </TooltipButton>
      }
      bar={
        <DecisionBar note={replacementNote(proposal)} error={error}>
          <Button
            variant={neverRead ? 'secondary' : 'primary'}
            disabled={saving || !!block}
            tooltip={block ?? { label: 'Save the ticked memories', shortcut: ['A'] }}
            onClick={approve}
          >
            {approveLabel(proposal, choices.keep.length)}
          </Button>
          <Button
            variant={neverRead ? 'primary' : 'secondary'}
            disabled={saving}
            tooltip={{ label: 'Save nothing from this read', shortcut: ['R'] }}
            onClick={reject}
          >
            Reject read
          </Button>
          {block && <span className="text-text-secondary text-sm">{block}</span>}
        </DecisionBar>
      }
    >
      {proposal.held > 0 && (
        <p className="text-text-tertiary text-sm">
          {formatCount(proposal.held, 'more claim was', 'more claims were')} over this read’s
          limit and held back. See how it was read for the reasons.
        </p>
      )}
      <fieldset disabled={saving} className="min-w-0 space-y-4">
        <ReviewQuestions proposal={proposal} choices={choices} onChange={setChoices} />
        <ReviewChecklist
          proposal={proposal}
          keep={choices.keep}
          onChange={(keep) => setChoices((old) => ({ ...old, keep }))}
        />
      </fieldset>
    </DecisionFrame>
  )
}

function replacementNote(proposal: BrainProposalView): string | undefined {
  if (proposal.job.replaces)
    return `Replaces ${formatCount(proposal.replacingMemories, 'memory', 'memories')} from the last read`
  return undefined
}
