import { useCallback, useState } from 'react'
import type { BrainProposalView, BrainReviewDecision } from '@shared/brain'
import { Button } from '@/components/form'
import { TooltipSummary } from '@/components/Tooltip'
import { useBrain } from './useBrain'
import { useBrainResource } from './useBrainResource'
import { buildReviewDecision } from './reviewDecision'
import { ReviewGroups, ReviewIdentities, ReviewMemories, ReviewPage } from './ReviewSections'

export function elapsedTime(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

export function BrainReview({
  jobId,
  onClose,
  onExtraction,
}: {
  jobId: string
  onClose: () => void
  onExtraction: (jobId: string) => void
}): React.JSX.Element {
  const jobState = useBrain((s) => s.status?.jobs.find((job) => job.id === jobId)?.state)
  const ready = jobState === 'review'
  const load = useCallback(() => window.phosphor.invoke('brain:proposal', jobId), [jobId])
  const { data, error, retry } = useBrainResource(load, ready)
  const [stale, setStale] = useState(false)
  return (
    <section className="space-y-3 p-3">
      <div className="flex gap-2">
        <Button size="sm" onClick={onClose}>
          Back to graph
        </Button>
        <Button size="sm" onClick={() => onExtraction(jobId)}>
          View extraction
        </Button>
      </div>
      {stale && <p role="alert">Brain changed; refreshing this review</p>}
      {!data ? (
        <p role="status">
          {error ||
            (ready
              ? 'Loading review…'
              : 'Brain changed; refreshing this review. Waiting for the job to return to review…')}
          {error && <Button onClick={retry}>Retry</Button>}
        </p>
      ) : (
        <ReviewProposal
          key={`${jobId}:${data.revision}`}
          proposal={data}
          onClose={onClose}
          onStale={() => {
            setStale(true)
            retry()
          }}
        />
      )}
    </section>
  )
}

function ReviewProposal({
  proposal,
  onClose,
  onStale,
}: {
  proposal: BrainProposalView
  onClose: () => void
  onStale: () => void
}): React.JSX.Element {
  const [keep, setKeep] = useState(() => proposal.memories.map((m) => m.index))
  const [identities, setIdentities] = useState<Record<string, string>>({})
  const [groups, setGroups] = useState<number[]>([])
  const saving = useBrain((s) => s.saving)
  const [error, setError] = useState('')
  const review = async (decision: BrainReviewDecision | null): Promise<void> => {
    setError('')
    if (await useBrain.getState().review(proposal.job.id, decision, proposal.revision)) onClose()
    else {
      const message = useBrain.getState().error
      setError(message)
      if (/changed|stale|revision/i.test(message)) {
        onStale()
        await useBrain.getState().refresh()
      }
    }
  }
  const confirmationsOnly = !proposal.memories.length && proposal.confirmations.length > 0
  return (
    <section aria-label="Review memories" className="space-y-4">
      <h2 className="text-xl font-semibold">{proposal.job.title}</h2>
      {error && <p role="alert">{error}</p>}
      <p className="text-text-tertiary text-sm">Nothing is searchable until you approve it.</p>
      {proposal.held > 0 && <p>{proposal.held} held back · inspect the extraction for reasons</p>}
      <div className="flex gap-2">
        <Button
          variant="primary"
          disabled={saving || (!keep.length && !confirmationsOnly && !groups.length)}
          onClick={() => {
            void review(buildReviewDecision(keep, identities, groups))
          }}
        >
          {confirmationsOnly ? 'Approve confirmations' : `Approve ${keep.length}`}
        </Button>
        <Button
          disabled={saving}
          onClick={() => {
            void review(null)
          }}
        >
          Reject all
        </Button>
      </div>
      <fieldset disabled={saving} className="space-y-4">
        <ReviewIdentities proposal={proposal} overrides={identities} onChange={setIdentities} />
        <ReviewGroups proposal={proposal} selected={groups} onChange={setGroups} />
        <ReviewMemories proposal={proposal} selected={keep} onChange={setKeep} />
      </fieldset>
      {proposal.confirmations.length > 0 && (
        <details>
          <TooltipSummary>
            {confirmationsOnly ? 'Confirms' : 'Also confirms'} {proposal.confirmations.length}{' '}
            existing memories
          </TooltipSummary>
          <ReviewPage>
            {proposal.confirmations.map((m) => (
              <p key={m.id}>{m.summary}</p>
            ))}
          </ReviewPage>
        </details>
      )}
    </section>
  )
}
