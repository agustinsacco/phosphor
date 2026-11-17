import { useCallback, useState } from 'react'
import type { BrainExtractionView } from '@shared/brain'
import { Button, Tag } from '@/components/form'
import { TooltipButton } from '@/components/Tooltip'
import { SectionLabel } from '@/features/sessions/SidebarPrimitives'
import { relativeTime } from '@/lib/time'
import { useBrainResource } from './useBrainResource'
import { useBrainModelName } from './useBrainModelName'
import { BrainReadAgain } from './BrainReadAgain'
import { durationWords } from './jobProgress'
import { ExtractionCalls } from './ExtractionCalls'
import { ExtractionSource } from './ExtractionSource'

const OUTCOME = {
  kept: 'kept',
  reconfirms: 'reconfirmed',
  folded: 'folded',
  enriches: 'enriches',
  held: 'held',
  dropped: 'dropped',
} as const
export function BrainExtraction({
  jobId,
  onBack,
  onMemory,
}: {
  jobId: string
  onBack?: () => void
  onMemory: (id: string, label: string) => void
}): React.JSX.Element {
  const load = useCallback(() => window.phosphor.invoke('brain:extraction', jobId), [jobId])
  const { data, error, retry } = useBrainResource(load)
  return (
    <section
      aria-label="Extraction detail"
      className="min-w-0 space-y-4 p-4 [overflow-wrap:anywhere]"
    >
      {onBack && (
        <Button size="sm" onClick={onBack}>
          Back to review
        </Button>
      )}
      {!data ? (
        <div role="status">
          {error || 'Loading extraction…'}
          {error && <Button onClick={retry}>Retry</Button>}
        </div>
      ) : (
        <FinishedRead data={data} onMemory={onMemory} />
      )}
    </section>
  )
}
function FinishedRead({
  data,
  onMemory,
}: {
  data: BrainExtractionView
  onMemory: (id: string, label: string) => void
}): React.JSX.Element {
  const model = useBrainModelName(data.model)
  return (
    <>
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-xl font-semibold">{data.title}</h2>
          <p className="text-text-tertiary text-sm">
            {model} · {data.thinking} thinking · took{' '}
            {durationWords(data.finishedAt - data.startedAt)} · {relativeTime(data.finishedAt)}
          </p>
        </div>
        {data.job?.state === 'done' && (
          <BrainReadAgain
            job={data.job}
            memories={data.laneMemories}
            replaceable={data.replaceable}
          />
        )}
      </header>
      {data.error && (
        <p role="status" className="text-danger">
          {data.error}
        </p>
      )}
      <ExtractionOutcomes data={data} onMemory={onMemory} />
      <section aria-label="Memories from this lane" className="space-y-2">
        <SectionLabel>Memories from this lane · {data.memories.length}</SectionLabel>
        <ul className="border-border bg-surface divide-border divide-y rounded-lg border">
          {data.memories.map((memory) => (
            <li key={memory.id}>
              <TooltipButton
                className="hover:bg-bg-secondary w-full px-4 py-3 text-left"
                onClick={() => onMemory(memory.id, memory.summary)}
              >
                {memory.summary}
              </TooltipButton>
            </li>
          ))}
        </ul>
      </section>
      <ExtractionCalls data={data} />
      <ExtractionSource source={data.source} />
    </>
  )
}
export function ExtractionOutcomes({
  data,
  onMemory,
}: {
  data: BrainExtractionView
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
