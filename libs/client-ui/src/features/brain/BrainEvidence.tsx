import { useState } from 'react'
import type { BrainCitation, BrainEvidence as Evidence } from '@shared/brain'
import { Button } from '@/components/form'
import type { BrainAction } from './useBrain'

export function BrainEvidence({
  citations,
  busy,
  act,
  onRead,
}: {
  citations: BrainCitation[]
  busy: boolean
  act: BrainAction
  onRead?: () => void
}): React.JSX.Element {
  const [originals, setOriginals] = useState<Evidence[]>([])
  return (
    <section aria-label="Original evidence" className="brain-card">
      <h3>Evidence quotes</h3>
      {citations.map((c, i) => (
        <blockquote key={`${c.evidenceId}-${i}`}>
          {c.quote}
          <footer>Evidence {c.evidenceId}</footer>
        </blockquote>
      ))}
      <Button
        disabled={busy || !citations.length}
        onClick={() => {
          void act(async () => {
            const evidence = await Promise.all(
              [...new Set(citations.map((c) => c.evidenceId))].map((id) =>
                window.phosphor.invoke('brain:read', id),
              ),
            )
            setOriginals(evidence)
            onRead?.()
          })
        }}
      >
        Read original evidence
      </Button>
      {originals.map((e) => (
        <article key={e.id}>
          <h3>
            {e.label} · {e.role}
          </h3>
          <p>
            {e.scope} · observed {new Date(e.observedAt).toLocaleString()} · {e.rootIds.length}{' '}
            independent root(s)
          </p>
          <p>
            Branch: {e.branch ?? 'project-wide'} · session {e.sessionId} · entry {e.entryId}
          </p>
          <pre className="brain-transcript" tabIndex={0}>
            {e.text}
          </pre>
        </article>
      ))}
      {!citations.length && <p>No cited evidence. This cannot be approved.</p>}
    </section>
  )
}
