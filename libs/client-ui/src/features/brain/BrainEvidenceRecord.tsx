import type { BrainEvidence } from '@shared/brain'

export function BrainEvidenceRecord({
  evidence: e,
}: {
  evidence: BrainEvidence
}): React.JSX.Element {
  return (
    <article>
      <h3>
        {e.label} · {e.role}
      </h3>
      <p>
        {e.scope} · observed {new Date(e.observedAt).toLocaleString()} · {e.rootIds.length}{' '}
        source/dependency root(s)
      </p>
      <p>
        Dependency roots do not establish independent corroboration. Assistant text and compaction
        summaries are generated context, not independent observations.
      </p>
      <p>
        Branch: {e.branch ?? 'project-wide'} · session {e.sessionId} · entry {e.entryId}
      </p>
      <pre className="brain-transcript" tabIndex={0}>
        {e.text}
      </pre>
    </article>
  )
}
