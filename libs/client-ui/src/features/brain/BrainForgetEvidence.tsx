import { useState } from 'react'
import { Button } from '@/components/form'
import type { BrainAction } from './useBrain'

export function BrainForgetEvidence({
  ids,
  busy,
  act,
  onDone,
  label = 'cited evidence',
  onForgot,
}: {
  ids: string[]
  busy: boolean
  act: BrainAction
  onDone: () => void
  label?: string
  onForgot?: (summary: string) => void
}): React.JSX.Element {
  const [confirmed, setConfirmed] = useState(false)
  const [result, setResult] = useState('')
  return (
    <section className="brain-card" aria-label="Confirm forgetting evidence">
      <h3>
        Forget {ids.length} {label} item(s)?
      </h3>
      <p>
        Removes this evidence and dependent memory, including claims beyond this view. Already
        delivered copies in session transcripts or at reasoning providers cannot be recalled or
        deleted by Brain.
      </p>
      <label className="brain-field">
        <span>
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(e) => setConfirmed(e.target.checked)}
          />{' '}
          I understand this permanent deletion and the delivered-copy limitation.
        </span>
      </label>
      <div className="brain-actions">
        <Button onClick={onDone}>Keep evidence</Button>
        <Button
          variant="danger"
          disabled={busy || !confirmed || !ids.length}
          onClick={() => {
            void act(async () => {
              const forgotten = await window.phosphor.invoke('brain:forget', ids)
              const summary = `Forgot ${forgotten.evidence} evidence items and ${forgotten.claims} claims. ${forgotten.affectedSessions.length} session(s) may retain delivered copies.`
              setResult(summary)
              onForgot?.(summary)
            })
          }}
        >
          Confirm forget evidence
        </Button>
      </div>
      {result && <p role="status">{result}</p>}
    </section>
  )
}
