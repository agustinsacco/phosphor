import { useState } from 'react'
import type { BrainExtractionView } from '@shared/brain'
import { ipcErrorText } from '@shared/errors'
import { Button } from '@/components/form'
import { TooltipSummary } from '@/components/Tooltip'
import { SectionLabel } from '@/features/sessions/SidebarPrimitives'
import { openBrainSource } from './openBrainSource'

export function ExtractionSource({
  source,
}: {
  source: BrainExtractionView['source']
}): React.JSX.Element {
  const [error, setError] = useState('')
  const [opening, setOpening] = useState(false)
  const open = async (): Promise<void> => {
    setOpening(true)
    setError('')
    try {
      await openBrainSource(source.sessionPath)
    } catch (cause) {
      setError(ipcErrorText(cause))
    } finally {
      setOpening(false)
    }
  }
  return (
    <details>
      <TooltipSummary className="cursor-pointer">Source lane at extraction</TooltipSummary>
      {!source.exists ? (
        <p className="text-text-tertiary text-sm">Source lane is no longer available.</p>
      ) : (
        <>
          <Button
            size="sm"
            disabled={opening}
            onClick={() => {
              void open()
            }}
          >
            Open lane
          </Button>
          {error && <p role="status">{error}</p>}
          <p className="text-text-tertiary text-sm">
            Up to {source.leafId ?? 'the clone point'} · last 300 segments, each clipped to 4,000
            characters.
          </p>
          <div className="max-h-96 space-y-3 overflow-auto">
            {source.segments.map((segment, index) => (
              <article key={index} className="border-border rounded-md border p-3">
                <SectionLabel>{segment.label}</SectionLabel>
                <pre className="text-sm whitespace-pre-wrap break-words">{segment.text}</pre>
              </article>
            ))}
            {!source.segments.length && <p>No source segments available at this clone point.</p>}
          </div>
        </>
      )}
    </details>
  )
}
