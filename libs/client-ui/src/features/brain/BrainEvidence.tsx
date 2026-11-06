import { useState } from 'react'
import type { BrainCitation, BrainEvidence as Evidence } from '@shared/brain'
import { Button } from '@/components/form'
import { BrainEvidenceRecord } from './BrainEvidenceRecord'
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
        <BrainEvidenceRecord key={e.id} evidence={e} />
      ))}
      {!citations.length && <p>No cited evidence. This cannot be approved.</p>}
    </section>
  )
}
