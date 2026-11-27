import { useState } from 'react'
import type { BrainExtractionView } from '@shared/brain'
import { Button, Tag } from '@/components/form'
import { TooltipButton } from '@/components/Tooltip'
import { SectionLabel } from '@/features/sessions/SidebarPrimitives'

const OUTCOME = {
  kept: 'kept',
  reconfirms: 'reconfirmed',
  folded: 'folded',
  enriches: 'enriches',
  held: 'held',
  dropped: 'dropped',
  noted: 'noted',
} as const
export function ExtractionOutcomes({
  data,
  onMemory,
}: {
  data: Pick<BrainExtractionView, 'outcomes'>
  onMemory: (id: string, label: string) => void
}): React.JSX.Element {
  const [shown, setShown] = useState(20)
  const counters = (Object.keys(OUTCOME) as (keyof typeof OUTCOME)[]).flatMap((status) => {
    const count = data.outcomes.filter((item) => item.status === status).length
    return count ? [`${count} ${OUTCOME[status]}`] : []
  })
  return (
    <section aria-label="Read result" className="space-y-2">
      <SectionLabel>Result{counters.length > 0 && ` · ${counters.join(', ')}`}</SectionLabel>
      <ol className="border-border bg-surface divide-border divide-y rounded-lg border">
        {data.outcomes.slice(0, shown).map((outcome) => (
          <li key={outcome.candidate} className="space-y-1 px-4 py-3">
            <div className="flex flex-wrap items-start gap-2">
              {outcome.memoryId && !outcome.removed ? (
                <TooltipButton
                  className="min-w-0 flex-1 text-left"
                  onClick={() => onMemory(outcome.memoryId!, outcome.summary)}
                >
                  {outcome.summary}
                </TooltipButton>
              ) : (
                <span className="min-w-0 flex-1">{outcome.summary}</span>
              )}
              <Tag>{outcome.removed ? 'removed' : OUTCOME[outcome.status]}</Tag>
            </div>
            {outcome.reason && <p className="text-text-tertiary text-sm">{outcome.reason}</p>}
          </li>
        ))}
      </ol>
      {!data.outcomes.length && <p className="text-text-tertiary text-sm">No candidates parsed.</p>}
      {shown < data.outcomes.length && (
        <Button size="sm" onClick={() => setShown(shown + 20)}>
          Show more
        </Button>
      )}
    </section>
  )
}
