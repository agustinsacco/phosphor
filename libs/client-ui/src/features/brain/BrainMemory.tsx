import { useCallback } from 'react'
import type { BrainEntity, BrainMemory, BrainQuote, BrainMemoryType } from '@shared/brain'
import { Button, Tag } from '@/components/form'
import { TooltipButton } from '@/components/Tooltip'
import { relativeTime } from '@/lib/time'
import { useBrain } from './useBrain'
import { useBrainResource } from './useBrainResource'

export const MEMORY_LABELS: Record<BrainMemoryType, string> = {
  decision: 'Decisions',
  open: 'Open questions',
  risk: 'Risks',
  procedure: 'Procedures',
  preference: 'Preferences',
  fact: 'Facts',
}

export function memoryRelation(memory: BrainMemory, entities: BrainEntity[]): string {
  const label = (id: string): string => entities.find((e) => e.id === id)?.label ?? id
  return memory.objectId
    ? `${label(memory.subjectId)} · ${memory.predicate.replaceAll('_', ' ')} · ${label(memory.objectId)}`
    : label(memory.subjectId)
}

export function MemoryTags({ memory }: { memory: BrainMemory }): React.JSX.Element {
  return (
    <div className="text-text-tertiary flex flex-wrap gap-1 text-sm">
      <Tag>{memory.type}</Tag>
      <Tag>{memory.kind}</Tag>
      <Tag>{memory.branch ? 'this branch' : 'project'}</Tag>
      <Tag>said {relativeTime(memory.observedAt)}</Tag>
      {memory.validFrom !== null && (
        <Tag>since {new Date(memory.validFrom).toISOString().slice(0, 10)}</Tag>
      )}
    </div>
  )
}

export function MemoryQuotes({ quotes }: { quotes: BrainQuote[] }): React.JSX.Element {
  return (
    <div className="space-y-3">
      {quotes.map((quote, index) => (
        <figure key={index} className="border-border bg-bg-secondary rounded-md border p-3 text-sm">
          <blockquote>
            {quote.before}
            <mark className="bg-accent-soft text-text rounded-sm">{quote.quote}</mark>
            {quote.after}
          </blockquote>
          <figcaption className="text-text-tertiary mt-2">{quote.label}</figcaption>
        </figure>
      ))}
    </div>
  )
}

export function BrainMemoryDetail({
  id,
  entities,
  onFocus,
  onForget,
}: {
  id: string
  entities: BrainEntity[]
  onFocus: (id: string) => void
  onForget: () => void
}): React.JSX.Element {
  const load = useCallback(() => window.phosphor.invoke('brain:memory', id), [id])
  const { data, error, retry } = useBrainResource(load)
  const saving = useBrain((s) => s.saving)
  if (!data)
    return (
      <div role="status" className="text-text-tertiary p-4">
        {error || 'Loading memory…'}
        {error && <Button onClick={retry}>Retry</Button>}
      </div>
    )
  const { memory, quotes } = data
  const entity = (entityId: string): React.ReactNode => (
    <TooltipButton className="text-accent hover:underline" onClick={() => onFocus(entityId)}>
      {entities.find((e) => e.id === entityId)?.label ?? entityId}
    </TooltipButton>
  )
  return (
    <article aria-label="Memory detail" className="space-y-4 p-4">
      <h2 className="text-lg font-medium">{memory.summary}</h2>
      <MemoryTags memory={memory} />
      <p>
        {entity(memory.subjectId)}{' '}
        {memory.objectId && (
          <>
            {memory.predicate.replaceAll('_', ' ')} {entity(memory.objectId)}
          </>
        )}
      </p>
      <MemoryQuotes quotes={quotes} />
      <footer className="text-text-tertiary flex items-center justify-between gap-3 text-sm">
        <span>{memory.origin && `From ${memory.origin.title}`}</span>
        <Button
          size="sm"
          variant="danger"
          disabled={saving}
          onClick={() => {
            void useBrain
              .getState()
              .forget(id)
              .then((ok) => {
                if (ok) onForget()
              })
          }}
        >
          Forget
        </Button>
      </footer>
    </article>
  )
}
