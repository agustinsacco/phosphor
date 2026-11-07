import type { BrainSnapshot } from '@shared/brain'
import type { BrainLearningDetail } from '@shared/brain-learning-jobs'
import { BrainProposalReview } from './BrainActivity'
import type { BrainAction } from './useBrain'

/** Reuses exact citations, evidence reads and the existing atomic revision contract. */
export function LearningReview({
  detail,
  snapshot,
  busy,
  act,
}: {
  detail: BrainLearningDetail
  snapshot: BrainSnapshot
  busy: boolean
  act: BrainAction
}): React.JSX.Element {
  const proposal = snapshot.proposals.find((p) => p.id === detail.proposalId)
  return (
    <>
      {proposal?.state === 'pending' && (
        <BrainProposalReview
          key={`${proposal.id}:${proposal.graphRevision}:${proposal.policyEpoch}`}
          proposal={proposal}
          current={snapshot}
          busy={busy}
          act={act}
        />
      )}
      {proposal && proposal.state !== 'pending' && (
        <p>
          Review: {proposal.state}. Rejection is not a processing failure and does not start another
          generation.
        </p>
      )}
      {detail.proposalId && !proposal && (
        <p>
          Proposal {detail.proposalId} is not in the bounded snapshot. Open Brain Activity to review
          available proposals; omission is not approval or failure.
        </p>
      )}
      {snapshot.truncated && <p>Partial review snapshot: some rows or evidence may be omitted.</p>}
    </>
  )
}
