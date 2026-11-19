import { useEffect, useState } from 'react'
import { brainLaneNeverRead } from '@phosphor/shared/brain-never-read'
import type { BrainProposalView } from '@shared/brain'
import { Button } from '@/components/form'
import { formatCount } from '@/lib/format'
import { brainToast, useBrain } from '../useBrain'
import { useBrainModelName } from '../useBrainModelName'
import { DecisionBar, DecisionFrame, type DecisionKeys } from './DecisionFrame'
import { ReviewQuestions, questionCount } from './ReviewQuestions'
import { ReviewChecklist } from './ReviewChecklist'
import {
  approveBlock,
  approveLabel,
  checklistTotal,
  initialChoices,
  reviewDecision,
  tickCount,
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
  const block = approveBlock(proposal, choices)
  const neverRead = useBrain((s) => !!s.status && brainLaneNeverRead(s.status.prefs.neverRead, job))
  const { error, approve, reject } = useReviewSubmit(proposal, choices, block, onStale)
  useEffect(() => {
    // Like the bar's buttons: nothing while a save runs.
    keys.current = saving ? {} : { primary: neverRead ? reject : approve, reject }
    return () => {
      keys.current = {}
    }
  })
  const questions = questionCount(proposal)
  return (
    <DecisionFrame
      label="Review memories"
      eyebrow="From lanes"
      title={job.title}
      subtitle={`${formatCount(checklistTotal(proposal), 'memory', 'memories')}${questions ? ` · ${formatCount(questions, 'question')}` : ''} · read by ${model}`}
      aside={
        <Button
          size="xs"
          tooltip="The model calls, the result of each claim and the source"
          onClick={onExtraction}
        >
          See how it was read
        </Button>
      }
      bar={
        <ReviewBar
          proposal={proposal}
          ticked={tickCount(choices)}
          block={block}
          neverRead={neverRead}
          saving={saving}
          error={error}
          onApprove={approve}
          onReject={reject}
        />
      }
    >
      {neverRead && (
        <p role="note" className="bg-bg-secondary/60 rounded-md px-3 py-2">
          You set Brain to never read this lane. Reject to discard this read.
        </p>
      )}
      {proposal.held > 0 && (
        <p className="text-text-tertiary text-sm">
          {formatCount(proposal.held, 'more claim was', 'more claims were')} over this read’s limit
          and held back. See how it was read for the reasons.
        </p>
      )}
      <fieldset disabled={saving} className="min-w-0 space-y-4">
        <ReviewQuestions proposal={proposal} choices={choices} onChange={setChoices} />
        <ReviewChecklist proposal={proposal} choices={choices} onChange={setChoices} />
      </fieldset>
    </DecisionFrame>
  )
}

/** Approve or reject; a stale review refreshes rather than failing silently. */
function useReviewSubmit(
  proposal: BrainProposalView,
  choices: ReviewChoices,
  block: string | null,
  onStale: () => Promise<void>,
) {
  const { job } = proposal
  const [error, setError] = useState('')
  const submit = async (approve: boolean): Promise<void> => {
    // Read live: a second key can land before the render that disables the bar.
    if (useBrain.getState().saving || (approve && block)) return
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
  return {
    error,
    approve: (): void => {
      void submit(true)
    },
    reject: (): void => {
      void submit(false)
    },
  }
}

function ReviewBar({
  proposal,
  ticked,
  block,
  neverRead,
  saving,
  error,
  onApprove,
  onReject,
}: {
  proposal: BrainProposalView
  ticked: number
  block: string | null
  neverRead: boolean
  saving: boolean
  error: string
  onApprove: () => void
  onReject: () => void
}): React.JSX.Element {
  return (
    <DecisionBar note={replacementNote(proposal)} error={error}>
      <Button
        variant={neverRead ? 'secondary' : 'primary'}
        disabled={saving || !!block}
        tooltip={
          block ??
          (neverRead
            ? 'Save the ticked memories'
            : { label: 'Save the ticked memories', shortcut: ['A'] })
        }
        onClick={onApprove}
      >
        {approveLabel(proposal, ticked)}
      </Button>
      <Button
        variant={neverRead ? 'primary' : 'secondary'}
        disabled={saving}
        tooltip={{ label: 'Save nothing from this read', shortcut: ['R'] }}
        onClick={onReject}
      >
        Reject read
      </Button>
      {block && <span className="text-text-secondary text-sm">{block}</span>}
    </DecisionBar>
  )
}

/** What this read covers: the whole lane again, or only what came after the previous read. */
function replacementNote(proposal: BrainProposalView): string | undefined {
  if (proposal.job.replaces)
    return `Replaces ${formatCount(proposal.replacingMemories, 'memory', 'memories')} from the last read`
  if (proposal.job.fromLeafId) return 'Reads new messages only'
  return undefined
}
