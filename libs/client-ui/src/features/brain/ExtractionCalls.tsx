import { useState } from 'react'
import type { BrainExtractionView, BrainExtractionCall } from '@shared/brain'
import { TooltipSummary } from '@/components/Tooltip'
import { CodeBlock } from '@/components/markdown/CodeBlock'
import { SectionLabel } from '@/features/sessions/SidebarPrimitives'
import { formatCount } from '@/lib/format'
import { BRAIN_STAGE_LABELS, elapsedTime } from './jobProgress'

export function ExtractionCalls({
  data,
}: {
  data: Pick<BrainExtractionView, 'calls' | 'prompts'>
}): React.JSX.Element {
  return (
    <section aria-label="How it was read" className="space-y-2">
      <SectionLabel>How it was read · {formatCount(data.calls.length, 'call')}</SectionLabel>
      <div className="border-border bg-surface divide-border divide-y rounded-lg border">
        {data.calls.map((call, index) => (
          <Call key={index} call={call} prompt={data.prompts[index]} />
        ))}
      </div>
    </section>
  )
}
function Call({
  call,
  prompt,
}: {
  call: BrainExtractionCall
  prompt: string | undefined
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <details className="min-w-0 p-3" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <TooltipSummary>
        {BRAIN_STAGE_LABELS[call.stage]} · part {call.part}
        {call.trace && ` · ${elapsedTime(call.trace.totalMs)}`}
      </TooltipSummary>
      {open && (
        <div className="mt-3 min-w-0 space-y-3">
          {call.error && <p role="status">{call.error}</p>}
          <SectionLabel>Raw agent output</SectionLabel>
          <div className="max-h-96 overflow-auto">
            <CodeBlock
              code={formatAgentOutput(call.answer) || '(No final text returned)'}
              language="text"
              chatActions={false}
            />
          </div>
          <SectionLabel>Prompt</SectionLabel>
          <div className="max-h-96 overflow-auto">
            <CodeBlock
              code={prompt || 'Prompt unavailable: source lane is gone.'}
              language="text"
              chatActions={false}
            />
          </div>
          <ExtractionTrace trace={call.trace} />
        </div>
      )}
    </details>
  )
}
function ExtractionTrace({
  trace,
}: {
  trace: BrainExtractionView['calls'][number]['trace']
}): React.JSX.Element {
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
            Stop: {trace.stopReason ?? 'none'} · {trace.reason}
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
function formatAgentOutput(answer: string): string {
  try {
    const parsed: unknown = JSON.parse(answer)
    return JSON.stringify(parsed, null, 2)
  } catch {
    return answer
  }
}
