import { formatBrainTime } from './brainTime'
import { useState } from 'react'
import type { BrainProposal, BrainSnapshot, BrainRevision } from '@shared/brain'
import { Button } from '@/components/form'
import { BrainEvidence } from './BrainEvidence'
import { BrainCapturedEvidence } from './BrainCapturedEvidence'
import type { BrainAction } from './useBrain'

type ActivityProps = { snapshot: BrainSnapshot; busy: boolean; act: BrainAction }
export function BrainActivity(props: ActivityProps): React.JSX.Element {
  const { snapshot, busy, act } = props
  const [transcript, setTranscript] = useState<string | null>(null)
  return (
    <section aria-label="Brain activity">
      <BrainCapturedEvidence {...props} />
      <ProcessWorkspace
        key={`${snapshot.policyEpoch}:${snapshot.prefs.processor?.provider}:${snapshot.prefs.processor?.id}`}
        {...props}
      />
      <h2 className="font-semibold">Jobs · manual only</h2>
      {!snapshot.jobs.length && (
        <p>No processing jobs. Nothing runs until you explicitly Process.</p>
      )}
      {snapshot.jobs.map((job) => (
        <article key={job.id} className="brain-card">
          <h3>
            {job.scope} · {job.state}
          </h3>
          <p>
            {job.model.provider}/{job.model.id} · {new Date(job.createdAt).toLocaleString()}
          </p>
          {job.error && <p role="alert">{job.error}</p>}
          <div className="brain-actions">
            {['queued', 'running'].includes(job.state) && (
              <Button
                disabled={busy}
                onClick={() => {
                  void act(() => window.phosphor.invoke('brain:cancel', job.id))
                }}
              >
                Cancel job
              </Button>
            )}
            <Button
              disabled={busy || !job.sessionPath}
              onClick={() => {
                void act(async () =>
                  setTranscript(await window.phosphor.invoke('brain:transcript', job.id)),
                )
              }}
            >
              Read-only transcript
            </Button>
          </div>
        </article>
      ))}
      {transcript !== null && (
        <section className="brain-card">
          <h3>Processing transcript · read-only</h3>
          <p>This does not reopen a session or run a model.</p>
          <pre className="brain-transcript" tabIndex={0}>
            {transcript}
          </pre>
          <Button onClick={() => setTranscript(null)}>Close transcript</Button>
        </section>
      )}
      <h2 className="font-semibold">Proposals · human review</h2>
      {snapshot.proposals
        .filter((p) => p.state === 'pending')
        .map((proposal) => (
          <Proposal
            key={`${proposal.id}:${proposal.graphRevision}:${proposal.policyEpoch}`}
            proposal={proposal}
            current={snapshot}
            busy={busy}
            act={act}
          />
        ))}
      {!snapshot.proposals.some((p) => p.state === 'pending') && (
        <p>No proposals awaiting review.</p>
      )}
    </section>
  )
}

function ProcessWorkspace({ snapshot, busy, act }: ActivityProps): React.JSX.Element {
  const [scope, setScope] = useState(snapshot.prefs.workspaces[0] ?? '')
  const [consent, setConsent] = useState(false)
  const processor = snapshot.prefs.processor
  const eligible =
    snapshot.prefs.enabled && snapshot.prefs.workspaces.includes(scope) && !!processor && consent
  return (
    <section className="brain-card">
      <h2>Process enrolled workspace</h2>
      <label className="brain-field">
        Workspace
        <select
          value={scope}
          onChange={(e) => {
            setScope(e.target.value)
            setConsent(false)
          }}
        >
          <option value="">Select workspace</option>
          {snapshot.prefs.workspaces.map((w) => (
            <option key={w} value={w}>
              {w}
            </option>
          ))}
        </select>
      </label>
      <p>
        Evidence will be sent to{' '}
        {processor
          ? `${processor.provider}/${processor.id}`
          : 'the exact model you select in Settings'}
        . Remote reasoning providers receive evidence text, even though embeddings are local. No
        fallback provider or model. Each click sends one batch of at most 200 whole sources and
        60,000 source bytes, prioritizing new evidence. The batch is not limited to the evidence
        page shown above. Output stays a proposal until you approve it.
      </p>
      <label className="brain-field">
        <span>
          <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />{' '}
          I consent to process this workspace’s evidence with this exact reasoning provider/model.
        </span>
      </label>
      <Button
        disabled={busy || !eligible}
        onClick={() => {
          if (!processor) return
          setConsent(false)
          void act(() =>
            window.phosphor.invoke('brain:process', scope, {
              policyEpoch: snapshot.policyEpoch,
              model: processor,
            }),
          )
        }}
      >
        Process workspace
      </Button>
    </section>
  )
}

function Proposal({
  proposal,
  current,
  busy,
  act,
}: {
  proposal: BrainProposal
  current: BrainRevision
  busy: boolean
  act: BrainAction
}): React.JSX.Element {
  const [read, setRead] = useState(false)
  const citations = proposal.input.claims.flatMap((c) => c.citations)
  const revision = { graphRevision: proposal.graphRevision, policyEpoch: proposal.policyEpoch }
  const samePolicy = current.policyEpoch === proposal.policyEpoch
  const stale = !samePolicy || current.graphRevision !== proposal.graphRevision
  const canApprove =
    !stale &&
    read &&
    proposal.input.claims.length > 0 &&
    proposal.input.claims.every((c) => c.citations.length > 0)
  return (
    <article className="brain-card" aria-label="Review proposal">
      <h3>Proposal for {proposal.scope}</h3>
      <p>{proposal.input.rationale}</p>
      {proposal.input.entities.map((e) => (
        <p key={e.key}>
          Entity: {e.label} · {e.kind} · aliases: {e.aliases.join(', ') || 'none'}
          {e.existingId ? ` · merges into existing entity ${e.existingId}` : ' · new entity'}
        </p>
      ))}
      {proposal.input.claims.map((claim, i) => (
        <div key={i}>
          <p>
            {claim.summary} · {claim.kind}
          </p>
          <p>
            {claim.subject} {claim.predicate} {claim.object ?? claim.literal}{' '}
            {claim.supersedes ? `· supersedes ${claim.supersedes}` : ''}
          </p>
          <p>
            Valid: {formatBrainTime(claim.validFrom)} → {formatBrainTime(claim.validTo)}
          </p>
        </div>
      ))}
      <BrainEvidence citations={citations} busy={busy} act={act} onRead={() => setRead(true)} />
      <p>
        Approval uses graph revision {revision.graphRevision}, policy epoch {revision.policyEpoch}.
        {stale
          ? ' This proposal is stale. Process again with current consent to produce a new review.'
          : ' Stale approval is refused.'}
        {stale && samePolicy && ' You can reject this graph-stale proposal.'}
      </p>
      <div className="brain-actions">
        <Button
          disabled={busy || !canApprove}
          onClick={() => {
            void act(() => window.phosphor.invoke('brain:review', proposal.id, true, revision))
          }}
        >
          Approve
        </Button>
        <Button
          disabled={busy || !samePolicy}
          onClick={() => {
            void act(() => window.phosphor.invoke('brain:review', proposal.id, false, revision))
          }}
        >
          Reject
        </Button>
      </div>
    </article>
  )
}
