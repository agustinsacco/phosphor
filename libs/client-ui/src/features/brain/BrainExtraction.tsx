import { useCallback, useState } from 'react'
import type { BrainExtractionView } from '@shared/brain'
import { ipcErrorText } from '@shared/errors'
import { Button, Tag } from '@/components/form'
import { TooltipSummary } from '@/components/Tooltip'
import { CodeBlock } from '@/components/markdown/CodeBlock'
import { SectionLabel } from '@/features/sessions/SidebarPrimitives'
import { formatCount } from '@/lib/format'
import { relativeTime } from '@/lib/time'
import { useBrainResource } from './useBrainResource'
import { elapsedTime } from './BrainReview'
import { openBrainSource } from './openBrainSource'

const OUTCOME = {
  kept: 'Kept',
  reconfirms: 'Re-confirms an existing memory',
  duplicate: 'Duplicate of another candidate',
  dropped: 'Dropped',
} as const

export function BrainExtraction({
  jobId,
  onBack,
  onMemory,
}: {
  jobId: string
  onBack: () => void
  onMemory: (id: string) => void
}): React.JSX.Element {
  const load = useCallback(() => window.phosphor.invoke('brain:extraction', jobId), [jobId])
  const { data, error, retry } = useBrainResource(load)
  return (
    <section aria-label="Extraction detail" className="space-y-4 p-4">
      <Button size="sm" onClick={onBack}>
        Back
      </Button>
      {!data ? (
        <div role="status">
          {error || 'Loading extraction…'}
          {error && <Button onClick={retry}>Retry</Button>}
        </div>
      ) : (
        <>
          <header>
            <h2 className="text-xl font-semibold">{data.title}</h2>
            <p className="text-text-tertiary text-sm">
              {data.model} · {data.thinking} thinking ·{' '}
              {elapsedTime(data.finishedAt - data.startedAt)} · {relativeTime(data.finishedAt)}
            </p>
          </header>
          {data.error && (
            <p role="status" className="text-danger">
              {data.error}
            </p>
          )}
          <ExtractionOutcomes data={data} onMemory={onMemory} />
          <section>
            <SectionLabel>Raw agent output</SectionLabel>
            <div className="max-h-96 overflow-auto">
              <CodeBlock
                code={data.answer || '(No final text returned)'}
                language="text"
                chatActions={false}
              />
            </div>
          </section>
          <details>
            <TooltipSummary className="cursor-pointer">Prompt</TooltipSummary>
            <CodeBlock code={data.prompt} language="text" chatActions={false} />
          </details>
          <ExtractionTrace data={data} />
          <ExtractionSource source={data.source} />
        </>
      )}
    </section>
  )
}
function ExtractionOutcomes({
  data,
  onMemory,
}: {
  data: BrainExtractionView
  onMemory: (id: string) => void
}): React.JSX.Element {
  return (
    <section className="space-y-2">
      <SectionLabel>Candidates</SectionLabel>
      <div className="flex flex-wrap gap-2">
        {(['kept', 'reconfirms', 'duplicate', 'dropped'] as const).map((status) => (
          <Tag key={status}>
            {formatCount(
              data.outcomes.filter((item) => item.status === status).length,
              status === 'reconfirms' ? 'reconfirmed' : status,
              status === 'duplicate'
                ? 'duplicates'
                : status === 'reconfirms'
                  ? 'reconfirmed'
                  : status,
            )}
          </Tag>
        ))}
      </div>
      <ol className="space-y-2">
        {data.outcomes.map((outcome) => (
          <li key={outcome.candidate} className="border-border rounded-md border p-3">
            {outcome.memoryId ? (
              <Button size="sm" onClick={() => onMemory(outcome.memoryId!)}>
                {outcome.summary}
              </Button>
            ) : (
              <p>{outcome.summary}</p>
            )}
            <p className="text-text-tertiary text-sm">
              {OUTCOME[outcome.status]}
              {outcome.reason && ` · ${outcome.reason}`}
            </p>
          </li>
        ))}
      </ol>
      {!data.outcomes.length && <p className="text-text-tertiary text-sm">No candidates parsed.</p>}
      {data.memories.length > 0 && (
        <details>
          <TooltipSummary>
            Produced {formatCount(data.memories.length, 'memory', 'memories')}
          </TooltipSummary>
          {data.memories.map((memory) => (
            <div key={memory.id}>
              <Button size="sm" onClick={() => onMemory(memory.id)}>
                {memory.summary}
              </Button>
            </div>
          ))}
        </details>
      )}
    </section>
  )
}
function ExtractionTrace({ data }: { data: BrainExtractionView }): React.JSX.Element {
  const trace = data.trace
  return (
    <section className="space-y-2">
      <SectionLabel>Trace</SectionLabel>
      {!trace ? (
        <p className="text-text-tertiary text-sm">No trace available.</p>
      ) : (
        <>
          <p>
            First token:{' '}
            {trace.firstMessageUpdateMs === null
              ? 'none'
              : `${Math.round(trace.firstMessageUpdateMs)} ms`}{' '}
            · {formatCount(trace.turns, 'turn')} ·{' '}
            {formatCount(
              trace.retries.filter((event) =>
                ['auto_retry_start', 'summarization_retry_attempt_start'].includes(event.type),
              ).length,
              'retry',
              'retries',
            )}
          </p>
          <p>
            Stop: {trace.stopReason ?? 'none'} · {trace.reason} ·{' '}
            {formatCount(trace.usage.tokens, 'token')}
          </p>
          <p className="text-text-tertiary text-sm">
            Input {trace.usage.input} · output {trace.usage.output} · cache read{' '}
            {trace.usage.cacheRead} · cache write {trace.usage.cacheWrite}
          </p>
          {trace.providerError && <p>{trace.providerError}</p>}
          {trace.retries.map((retry, index) => (
            <p key={index} className="text-text-tertiary text-sm">
              {retry.type} · attempt {retry.attempt ?? '—'} · {retry.delayMs ?? 0} ms ·{' '}
              {retry.errorMessage ?? (retry.success ? 'succeeded' : '')}
            </p>
          ))}
        </>
      )}
    </section>
  )
}
function ExtractionSource({
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
