import type { BrainLearningCheckpointSummary } from '@shared/brain-learning-jobs'
import type { BrainLearningBinding } from '@shared/brain-learning'

export function LearningSource({
  checkpoint,
  binding,
  branch,
  coveredCount,
  newCount,
  reprocessed = false,
}: {
  checkpoint: BrainLearningCheckpointSummary
  binding: BrainLearningBinding
  branch: string | null
  coveredCount: number
  newCount: number
  reprocessed?: boolean
}): React.JSX.Element {
  const { source } = checkpoint
  return (
    <section className="brain-card" aria-label="Frozen source checkpoint">
      <h3>
        {binding.provider}/{binding.modelId} · thinking {binding.thinkingLevel}
      </h3>
      <p>
        Provider API: {binding.api} · Endpoint: {binding.endpoint}
      </p>
      <p>
        Selected configured account slot: {binding.accountId} · {binding.authMode}. This is not a
        claim about historical billing identity.
      </p>
      <p>
        {branch === null
          ? 'Confirmed branchless folder'
          : `Acknowledged workspace branch: ${branch}`}
        . This is workspace authority acknowledged for this run, not proof of the historical source
        branch.
      </p>
      <p>
        Session {source.sessionId} · selected leaf {source.selectedLeafId}
      </p>
      <p>
        Projected contributions: {newCount} eligible for this run
        {reprocessed ? ' (reprocessed inputs)' : ''}, {coveredCount} covered. Total selected
        ancestry: {checkpoint.sourceEntryCount} entries. Only preserved projected context is sent;
        omitted raw history is not recovered.
      </p>
      <p>Source digest: {source.sourceDigest}</p>
      <p>Selected ancestry digest: {source.contentDigest}</p>
      <p>Projection digest: {checkpoint.projectionDigest}</p>
    </section>
  )
}
