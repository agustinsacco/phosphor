import { useCallback } from 'react'
import type {
  BrainEntity,
  BrainMemory,
  BrainQuote,
  BrainMemoryType,
  BrainMemoryDetail as MemoryDetail,
} from '@shared/brain'
import { Button, Tag } from '@/components/form'
import { TooltipButton, TooltipSummary } from '@/components/Tooltip'
import { relativeTime } from '@/lib/time'
import { brainToast, useBrain } from './useBrain'
import { openBrainSource } from './openBrainSource'
import { ipcErrorText } from '@shared/errors'
import { EntityChip, KnowledgeHeading } from './explorer/KnowledgePrimitives'
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
        <figure
          key={index}
          className="border-border border-l-2 pl-3 text-sm [overflow-wrap:anywhere]"
        >
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
    <article aria-label="Memory detail" className="space-y-4 py-3 [overflow-wrap:anywhere]">
      <div className="text-text-tertiary flex flex-wrap items-center gap-2 text-sm">
        <Tag>{memory.type}</Tag>
        <span>
          {memory.state === 'active' ? 'current' : memory.state} · learned{' '}
          {relativeTime(memory.recordedAt)}
        </span>
      </div>
      <h2 className="text-lg font-medium">{memory.summary}</h2>
      <MemoryEvidence data={data} onFocus={onFocus} onMemory={onMemory} />
      {memory.jobId && (
        <TooltipButton
          className="text-text-secondary text-left text-sm hover:underline"
          onClick={() => onExtraction(memory.jobId!)}
        >
          See the read that produced this
        </TooltipButton>
      )}
      <footer className="text-text-tertiary flex items-center justify-between gap-3 text-sm">
        <span>
          {memory.origin && `From ${memory.origin.title}`}{' '}
          {data.sourcePath && <OpenSource path={data.sourcePath} />}
        </span>
        <TooltipButton
          className="text-danger hover:bg-danger-soft rounded-md px-2 py-1"
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
        </TooltipButton>
      </footer>
    </article>
  )
}

function OpenSource({ path }: { path: string }): React.JSX.Element {
  return (
    <TooltipButton
      className="hover:text-text underline"
      onClick={() => {
        openBrainSource(path).catch((cause: unknown) => brainToast(ipcErrorText(cause), 'error'))
      }}
    >
      Open in lane
    </TooltipButton>
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
    const found = entities.find((e) => e.id === id)
    const label = found?.label ?? id
    return <EntityChip label={label} kind={found?.kind} onClick={() => onFocus(id, label)} />
  }
  const quotes = (items: BrainQuote[]): React.ReactNode => <MemoryQuotes quotes={items} />
  return (
    <>
      <div className="flex flex-wrap gap-2">
        {memory.entityIds.map((id) => (
          <span key={id} className="max-w-full">
            {entity(id)}
          </span>
        ))}
      </div>
      <section aria-label="Evidence">
        <KnowledgeHeading>Evidence</KnowledgeHeading>
        {quotes(data.quotes)}
      </section>
      {memory.links.length > 0 && (
        <section aria-label="Links">
          <KnowledgeHeading>Links</KnowledgeHeading>
          {memory.links.map((link) => (
            <div key={link.id} className="space-y-2 py-2">
              <p>
                {entity(link.subjectId)}{' '}
                <span className="text-text-secondary">{link.predicate.replaceAll('_', ' ')}</span>{' '}
                {entity(link.objectId)}
              </p>
              {quotes(data.linkQuotes[link.id] ?? [])}
            </div>
          ))}
        </section>
      )}
      <MemoryHistory data={data} onMemory={onMemory} />
      <details className="text-text-tertiary text-sm">
        <TooltipSummary>Dates and scope</TooltipSummary>
        <MemoryTags memory={memory} />
      </details>
    </>
  )
}

function MemoryHistory({
  data,
  onMemory,
}: {
  data: MemoryDetail
  onMemory: (id: string, label: string) => void
}): React.JSX.Element {
  return (
    <>
      {data.history.length > 0 && (
        <section>
          <KnowledgeHeading>History</KnowledgeHeading>
          {data.history.map((m) => (
            <TooltipButton
              className="brain-row"
              key={m.id}
              onClick={() => onMemory(m.id, m.summary)}
            >
              {m.summary} · {m.state}
            </TooltipButton>
          ))}
        </section>
      )}
      {data.related.length > 0 && (
        <section>
          <KnowledgeHeading>Related</KnowledgeHeading>
          {data.related.map(({ kind, memory: m }) => (
            <TooltipButton
              className="brain-row"
              key={`${kind}:${m.id}`}
              onClick={() => onMemory(m.id, m.summary)}
            >
              {kind}: {m.summary} · {m.state}
            </TooltipButton>
          ))}
        </section>
      )}
    </>
  )
}
