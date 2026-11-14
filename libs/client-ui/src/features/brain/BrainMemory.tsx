import { useCallback } from 'react'
import type {
  BrainEntity,
  BrainMemory,
  BrainQuote,
  BrainMemoryType,
  BrainMemoryDetail as MemoryDetail,
} from '@shared/brain'
import { Button, Tag } from '@/components/form'
import { TooltipButton } from '@/components/Tooltip'
import { relativeTime } from '@/lib/time'
import { brainToast, useBrain } from './useBrain'
import { openBrainSource } from './openBrainSource'
import { ipcErrorText } from '@shared/errors'
import { useBrainResource } from './useBrainResource'

export const MEMORY_LABELS: Record<BrainMemoryType, string> = {
  decision: 'Decisions',
  open: 'Open',
  risk: 'Risks',
  procedure: 'How things are done',
  preference: 'Preferences',
  fact: 'Facts',
}

export function memoryRelation(memory: BrainMemory, entities: BrainEntity[]): string {
  const label = (id: string): string => entities.find((e) => e.id === id)?.label ?? id
  return memory.links.length
    ? memory.links
        .map(
          (link) =>
            `${label(link.subjectId)} → ${link.predicate.replaceAll('_', ' ')} → ${label(link.objectId)}`,
        )
        .join('; ')
    : memory.entityIds.map(label).join(', ')
}

export function MemoryTags({ memory }: { memory: BrainMemory }): React.JSX.Element {
  return (
    <div className="text-text-tertiary flex flex-wrap gap-1 text-sm">
      <Tag>{memory.type}</Tag>
      <Tag>{memory.state}</Tag>
      <Tag>{memory.kind}</Tag>
      <Tag>{memory.branch ? 'this branch' : 'project'}</Tag>
      <Tag>said {relativeTime(memory.observedAt)}</Tag>
      <Tag>recorded {relativeTime(memory.recordedAt)}</Tag>
      {memory.validTo !== null && (
        <Tag>until {new Date(memory.validTo).toISOString().slice(0, 10)}</Tag>
      )}
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
  onFocus,
  onForget,
  onExtraction,
  onMemory,
}: {
  id: string
  onFocus: (id: string, label: string) => void
  onForget: () => void
  onExtraction: (jobId: string) => void
  onMemory: (id: string, label: string) => void
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
  const { memory } = data
  return (
    <article aria-label="Memory detail" className="space-y-4 p-4">
      <h2 className="text-lg font-medium">{memory.summary}</h2>
      <MemoryTags memory={memory} />
      <MemoryEvidence data={data} onFocus={onFocus} onMemory={onMemory} />
      {memory.jobId && (
        <Button size="sm" onClick={() => onExtraction(memory.jobId!)}>
          View extraction
        </Button>
      )}
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

function MemoryEvidence({
  data,
  onFocus,
  onMemory,
}: {
  data: MemoryDetail
  onFocus: (id: string, label: string) => void
  onMemory: (id: string, label: string) => void
}): React.JSX.Element {
  const { memory, entities } = data
  const entity = (id: string): React.ReactNode => {
    const label = entities.find((e) => e.id === id)?.label ?? id
    return (
      <TooltipButton className="text-accent hover:underline" onClick={() => onFocus(id, label)}>
        {label}
      </TooltipButton>
    )
  }
  return (
    <>
      <div className="flex flex-wrap gap-2">
        {memory.entityIds.map((id) => (
          <span key={id}>{entity(id)}</span>
        ))}
      </div>
      {memory.links.map((link) => (
        <section key={link.id} className="space-y-2">
          <p>
            {entity(link.subjectId)} → {link.predicate.replaceAll('_', ' ')} →{' '}
            {entity(link.objectId)}
          </p>
          <MemoryQuotes quotes={data.linkQuotes[link.id] ?? []} />
        </section>
      ))}
      <MemoryQuotes quotes={data.quotes} />
      {data.sourcePath && (
        <Button
          size="sm"
          onClick={() => {
            openBrainSource(data.sourcePath!).catch((cause: unknown) =>
              brainToast(ipcErrorText(cause), 'error'),
            )
          }}
        >
          Open in lane
        </Button>
      )}
      {data.history.length > 0 && (
        <section>
          <h3>History</h3>
          {data.history.map((m) => (
            <Button key={m.id} size="sm" onClick={() => onMemory(m.id, m.summary)}>
              {m.summary} · {m.state}
            </Button>
          ))}
        </section>
      )}
      {data.related.length > 0 && (
        <section>
          <h3>Related</h3>
          {data.related.map(({ kind, memory: m }) => (
            <Button key={`${kind}:${m.id}`} size="sm" onClick={() => onMemory(m.id, m.summary)}>
              {kind}: {m.summary} · {m.state}
            </Button>
          ))}
        </section>
      )}
    </>
  )
}
