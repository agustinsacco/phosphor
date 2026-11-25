import { brainLinkSentence, type BrainEntity } from '@shared/brain'
import type { BrainHit } from '@shared/brain-recall'
import { Button } from '@/components/form'
import { TooltipButton } from '@/components/Tooltip'
import { formatCount } from '@/lib/format'
import { memoryWords } from '../card/memoryWords'
import type { MapStep } from '../map/SentenceMap'
import type { AskAnswerState } from './useBrainScreen'

/** How a hit was reached, as sentences: "via Mara Voss set the invoice close date for Ledger". */
export function trailWords(hit: BrainHit, entities: BrainEntity[]): string | null {
  if (!hit.trail?.links.length) return null
  const label = (id: string): string => entities.find((e) => e.id === id)?.label ?? 'Unknown'
  return `via ${hit.trail.links
    .map((link) => brainLinkSentence(link, label(link.subjectId), label(link.objectId)))
    .join(', then ')}`
}

/** Brain's answer in the card's place: the memories it found, each with its trail. */
export function AskAnswer({
  answer,
  onClose,
  onStep,
}: {
  answer: AskAnswerState
  onClose: () => void
  onStep: (step: MapStep) => void
}): React.JSX.Element {
  const { recall, question } = answer
  const now = Date.now()
  const label = (id: string): string => recall.entities.find((e) => e.id === id)?.label ?? id
  return (
    <section aria-label="Answer" className="space-y-3 p-4">
      <header className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="brain-type-label">Answer</p>
          <h2 className="text-lg font-semibold [overflow-wrap:anywhere]">{question}</h2>
        </div>
        <Button size="xs" onClick={onClose}>
          Close
        </Button>
      </header>
      {recall.status !== 'ok' ? (
        <p className="text-text-secondary">
          {recall.status === 'unavailable'
            ? 'Brain can’t search right now. Try again in a moment.'
            : 'Brain knows nothing about that yet.'}
        </p>
      ) : (
        <>
          <p className="text-text-tertiary text-sm">
            {formatCount(recall.hits.length, 'memory', 'memories')}
            {recall.more ? ` · ${recall.more} more match` : ''} · lit on the map
          </p>
          <ol className="space-y-2">
            {recall.hits.map((hit) => {
              const target = hit.trail?.entityId ?? hit.memory.entityIds[0]
              const via = trailWords(hit, recall.entities)
              return (
                <li key={hit.memory.id}>
                  <TooltipButton
                    tooltip={target ? `Walk to ${label(target)}` : false}
                    className="hover:bg-bg-secondary block w-full rounded-md p-2 text-left"
                    onClick={() =>
                      target && onStep({ to: { id: target, label: label(target) }, link: null })
                    }
                  >
                    <span className="block">{hit.memory.summary}</span>
                    {via && <span className="text-accent block text-sm">{via}</span>}
                    <span className="text-text-tertiary block text-xs">
                      {memoryWords(hit.memory, now)}
                    </span>
                  </TooltipButton>
                </li>
              )
            })}
          </ol>
        </>
      )}
      {recall.degradation.map((note) => (
        <p key={note} className="text-text-tertiary text-sm">
          {note}
        </p>
      ))}
    </section>
  )
}
