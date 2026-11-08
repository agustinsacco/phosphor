import { useState } from 'react'
import {
  BRAIN_PREDICATES,
  type BrainClaim,
  type BrainCorrection,
  type BrainEntity,
  type BrainRevision,
} from '@shared/brain'
import { Button } from '@/components/form'
import { BrainEvidence } from './BrainEvidence'
import { BrainForgetEvidence } from './BrainForgetEvidence'
import { formatBrainTime } from './brainTime'
import type { BrainAction } from './useBrain'

type InspectorProps = {
  claim: BrainClaim
  entities: BrainEntity[]
  revision: BrainRevision
  busy: boolean
  act: BrainAction
}
export function BrainInspector(props: InspectorProps): React.JSX.Element {
  const { claim, busy, act } = props
  const [correcting, setCorrecting] = useState(false)
  const [forgetting, setForgetting] = useState(false)
  return (
    <aside className="brain-card" aria-label="Claim inspector">
      <h2>{claim.summary}</h2>
      <p>
        {claim.kind === 'inferred' ? 'Inferred · not a directly observed fact' : claim.kind} ·{' '}
        {claim.state}
      </p>
      <p>
        {claim.subjectId} {claim.predicate} {claim.objectId ?? claim.literal}
      </p>
      <p>Conflicts: {claim.conflictIds.join(', ') || 'none recorded'}</p>
      <p>
        Valid {formatBrainTime(claim.validFrom)} → {formatBrainTime(claim.validTo)} · recorded{' '}
        {formatBrainTime(claim.recordedAt)} · retracted {formatBrainTime(claim.retractedAt)}
      </p>
      <BrainEvidence citations={claim.citations} busy={busy} act={act} />
      <div className="brain-actions">
        <Button onClick={() => setCorrecting(!correcting)}>Correct claim…</Button>
        <Button onClick={() => setForgetting(!forgetting)}>Forget cited evidence…</Button>
      </div>
      {correcting && <CorrectionForm {...props} onDone={() => setCorrecting(false)} />}
      {forgetting && (
        <BrainForgetEvidence
          ids={[...new Set(claim.citations.map((c) => c.evidenceId))]}
          busy={busy}
          act={act}
          onDone={() => setForgetting(false)}
        />
      )}
    </aside>
  )
}

function CorrectionForm({
  claim,
  entities,
  revision,
  busy,
  act,
  onDone,
}: InspectorProps & { onDone: () => void }): React.JSX.Element {
  const [draft, setDraft] = useState<BrainCorrection>({
    subjectId: claim.subjectId,
    predicate: claim.predicate,
    objectId: claim.objectId,
    literal: claim.literal,
    summary: claim.summary,
    validFrom: claim.validFrom,
    validTo: claim.validTo,
    reason: '',
  })
  const [confirmed, setConfirmed] = useState(false)
  const valid =
    !!draft.summary.trim() &&
    !!draft.reason.trim() &&
    !!draft.subjectId &&
    !!draft.objectId !== !!draft.literal?.trim() &&
    (draft.validFrom === null || draft.validTo === null || draft.validFrom <= draft.validTo)
  return (
    <form
      className="brain-card"
      onSubmit={(e) => {
        e.preventDefault()
        if (valid && confirmed)
          void act(() => window.phosphor.invoke('brain:correct', claim.id, draft, revision)).then(
            (ok) => {
              if (ok) onDone()
            },
          )
      }}
    >
      <h3>Explicit human correction</h3>
      <CorrectionRelationship draft={draft} setDraft={setDraft} entities={entities} />
      <label className="brain-field">
        Summary
        <input
          value={draft.summary}
          onChange={(e) => setDraft({ ...draft, summary: e.target.value })}
          required
          maxLength={4000}
        />
      </label>
      <label className="brain-field">
        Reason
        <textarea
          value={draft.reason}
          onChange={(e) => setDraft({ ...draft, reason: e.target.value })}
          required
          maxLength={4000}
        />
      </label>
      <TemporalFields draft={draft} setDraft={setDraft} />
      <label className="brain-field">
        <span>
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(e) => setConfirmed(e.target.checked)}
          />{' '}
          I reviewed the original evidence and want to replace this claim.
        </span>
      </label>
      <p>
        Uses graph revision {revision.graphRevision} and policy epoch {revision.policyEpoch}; stale
        edits are refused.
      </p>
      <Button type="submit" disabled={busy || !valid || !confirmed}>
        Confirm correction
      </Button>
    </form>
  )
}

function TemporalFields({
  draft,
  setDraft,
}: {
  draft: BrainCorrection
  setDraft: (draft: BrainCorrection) => void
}): React.JSX.Element {
  return (
    <>
      {(['validFrom', 'validTo'] as const).map((field) => (
        <label key={field} className="brain-field">
          {field === 'validFrom' ? 'Valid from (UTC)' : 'Valid until (UTC)'}
          <input
            type="datetime-local"
            value={draft[field] === null ? '' : new Date(draft[field]).toISOString().slice(0, 16)}
            onChange={(e) =>
              setDraft({
                ...draft,
                [field]: e.target.value ? new Date(`${e.target.value}Z`).getTime() : null,
              })
            }
          />
        </label>
      ))}
    </>
  )
}

function CorrectionRelationship({
  draft,
  setDraft,
  entities,
}: {
  draft: BrainCorrection
  setDraft: (draft: BrainCorrection) => void
  entities: BrainEntity[]
}): React.JSX.Element {
  return (
    <>
      <label className="brain-field">
        Subject
        <select
          value={draft.subjectId}
          onChange={(e) => setDraft({ ...draft, subjectId: e.target.value })}
        >
          {entities.map((n) => (
            <option value={n.id} key={n.id}>
              {n.label}
            </option>
          ))}
        </select>
      </label>
      <label className="brain-field">
        Relationship
        <select
          value={draft.predicate}
          onChange={(e) =>
            setDraft({ ...draft, predicate: e.target.value as BrainCorrection['predicate'] })
          }
        >
          {BRAIN_PREDICATES.map((p) => (
            <option key={p}>{p}</option>
          ))}
        </select>
      </label>
      <label className="brain-field">
        Object entity (or use literal)
        <select
          value={draft.objectId ?? ''}
          onChange={(e) =>
            setDraft({
              ...draft,
              objectId: e.target.value || null,
              literal: e.target.value ? null : draft.literal,
            })
          }
        >
          <option value="">Literal value</option>
          {entities.map((n) => (
            <option value={n.id} key={n.id}>
              {n.label}
            </option>
          ))}
        </select>
      </label>
      {!draft.objectId && (
        <label className="brain-field">
          Literal
          <input
            value={draft.literal ?? ''}
            onChange={(e) => setDraft({ ...draft, literal: e.target.value })}
            required
          />
        </label>
      )}
    </>
  )
}
