import type { BrainLearningPreview, BrainLearningDetail } from '@shared/brain-learning-jobs'
import { LearningSource } from './LearningSource'

export function LearningTerms({
  preview,
  previous,
  reprocess,
}: {
  preview: BrainLearningPreview
  previous: BrainLearningDetail | null
  reprocess: boolean
}): React.JSX.Element {
  return (
    <>
      <p>
        Scope: {preview.scope} · policy epoch {preview.policyEpoch}
      </p>
      <LearningSource {...preview} />
      <p>Consent fingerprint: {preview.fingerprint}</p>
      <p>
        One logical generation with this source binding. The whole preserved pi-projected context,
        including system/tool history, thinking and completed assistant work, is sent. Original
        branch stays unchanged. Findings require manual review; nothing is automatically accepted.
      </p>
      <p>
        No guaranteed cache hit, identical cache prefix or warm-process reuse. Vendor-internal
        attempts are unknown. The private temporary source copy is deleted after completion, not
        opened as a lane.
      </p>
      {preview.limitations.length > 0 && (
        <ul aria-label="Learning limitations">
          {preview.limitations.map((item, i) => (
            <li key={i}>{item}</li>
          ))}
        </ul>
      )}
      {previous && (
        <p>
          Previous attempt {previous.job.id}: {previous.job.state}. Exact repeats, including
          rejected proposals, reuse prior processing; rejection is not failure.
        </p>
      )}
      {reprocess && (
        <p>
          Explicit retry / reprocess may incur another charge. Failed, cancelled or interrupted
          attempts may already have incurred unreported usage.
        </p>
      )}
    </>
  )
}
