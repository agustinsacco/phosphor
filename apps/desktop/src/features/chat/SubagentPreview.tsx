import { TooltipButton, TooltipSummary } from '@/components/Tooltip'
import { useState } from 'react'
import clsx from 'clsx'
import { CopyButton } from '@/components/CopyButton'
import type { SubagentInspection } from './subagentInspect'
import type { SupervisorHandoff } from './subagentPresentation'
import { SubagentText } from './SubagentText'

type Message = SubagentInspection['messages'][number]
interface ActivityRecord {
  kind: 'call' | 'output' | 'message' | 'thinking' | 'other'
  label: string
  preview: string
  message: Message
}

const CALL = /^\[tool: ([^\s\]]+)(?: ([\s\S]*))?\]$/
const firstLine = (text: string): string =>
  (text.split('\n').find((line) => line.trim()) ?? '')
    .replace(/^#+\s*/, '')
    .trim()
    .slice(0, 200)

/** From reported kinds, else the `[tool: name]` marker. Never pairs calls with outputs. */
function classify(message: Message): ActivityRecord {
  const call =
    message.kind === 'toolCall'
      ? (CALL.exec(message.text.trim()) ?? [message.text, message.name ?? 'tool'])
      : message.role === 'assistant' && !message.kind
        ? CALL.exec(message.text.trim())
        : null
  if (call) return { kind: 'call', label: call[1]!, preview: call[2] ?? '', message }
  if (message.role.toLowerCase() === 'toolresult')
    return {
      kind: 'output',
      label: message.isError ? 'Tool error' : 'Output',
      preview: firstLine(message.text),
      message,
    }
  if (message.role === 'thinking' || message.kind === 'thinking')
    return { kind: 'thinking', label: 'Thinking', preview: firstLine(message.text), message }
  if (message.role === 'assistant')
    return { kind: 'message', label: 'Agent', preview: firstLine(message.text), message }
  return { kind: 'other', label: message.role, preview: firstLine(message.text), message }
}

function RecordLine({ record }: { record: ActivityRecord }): React.JSX.Element {
  return (
    <span className="flex min-w-0 flex-1 items-baseline gap-2">
      <span
        className={clsx(
          'shrink-0',
          record.kind === 'call' ? 'text-text font-mono text-xs' : 'text-text-secondary text-xs',
          record.message.isError && 'text-danger',
        )}
      >
        {record.label}
      </span>
      <span className="text-text-tertiary min-w-0 truncate text-xs">{record.preview}</span>
    </span>
  )
}

/** A long prompt shows its opening; the whole prompt stays one click away. */
function TaskSection({ input }: { input?: string }): React.JSX.Element {
  const long = !!input && (input.length > 360 || input.split('\n').length > 6)
  const [open, setOpen] = useState(false)
  return (
    <section aria-label="Agent input" className="mb-4">
      <div className="mb-1 flex items-center justify-between gap-2">
        <h4 className="font-medium">Task</h4>
        {input && <CopyButton text={input} />}
      </div>
      {input ? (
        <>
          <div
            className={clsx(
              'text-text-secondary break-words text-sm',
              long &&
                !open &&
                'max-h-28 overflow-hidden [mask-image:linear-gradient(to_bottom,black_60%,transparent)]',
            )}
          >
            <SubagentText text={input} />
          </div>
          {long && (
            <TooltipButton
              type="button"
              aria-expanded={open}
              onClick={() => setOpen(!open)}
              className="text-text-secondary hover:text-text mt-1 text-xs underline underline-offset-2"
            >
              {open ? 'Show less' : 'Show full task'}
            </TooltipButton>
          )}
        </>
      ) : (
        <p className="text-text-tertiary text-xs">Not reported for this agent.</p>
      )}
    </section>
  )
}

/** What the agent is doing, what it returned, and what it was asked, in that order. */
export function SubagentPreview({
  inspection,
  handoff,
  live = false,
  now,
  loading = false,
}: {
  inspection?: SubagentInspection
  handoff?: SupervisorHandoff
  /** The agent is reported running. */
  live?: boolean
  /** Its current activity line, from the snapshot. */
  now?: string
  loading?: boolean
}): React.JSX.Element {
  const input = handoff?.input ?? inspection?.task
  const notification = handoff?.kind === 'notification' ? handoff.output : undefined
  // Only the parent's own settled tool result is proof of delivery.
  const received = handoff?.kind === 'tool-result' ? handoff.output : undefined
  const output = received ?? inspection?.finalOutput
  const records = (inspection?.messages ?? []).filter((m) => m.role !== 'user').map(classify)
  const inputs = (inspection?.messages ?? []).filter((m) => m.role === 'user' && m.text !== input)
  const calls = records.filter((r) => r.kind === 'call').length
  const occurrences = new Map<string, number>()
  const receivedAt =
    handoff?.receivedAt !== undefined && Number.isFinite(handoff.receivedAt)
      ? new Date(handoff.receivedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
      : undefined
  return (
    <div
      data-testid="subagent-transcript"
      aria-label="Subagent activity"
      tabIndex={0}
      className="min-h-0 flex-1 overflow-auto overscroll-contain p-3 text-sm [overflow-anchor:none]"
    >
      {live && (
        <section aria-label="Live activity" className="mb-4">
          <h4 className="mb-1 flex items-center gap-2 font-medium">
            <span aria-hidden className="tool-running-dot bg-accent size-2 rounded-full" />
            Now
            {now && (
              <span className="text-text-secondary min-w-0 truncate text-xs font-normal">
                {now}
              </span>
            )}
          </h4>
          {records.length > 0 ? (
            <ol data-testid="subagent-latest" className="space-y-0.5">
              {records
                .slice(-6)
                .reverse()
                .map((record, i) => (
                  <li
                    key={i}
                    className={clsx(i > 0 && 'opacity-80')}
                    data-tooltip={record.message.text.slice(0, 400)}
                  >
                    <RecordLine record={record} />
                  </li>
                ))}
            </ol>
          ) : (
            <p className="text-text-tertiary text-xs">
              {loading ? 'Reading activity…' : 'No steps reported yet.'}
            </p>
          )}
        </section>
      )}
      {(output || !live) && (
        <section aria-label="Agent output" className="mb-4">
          <div className="mb-1 flex items-center justify-between gap-2">
            <h4 className="flex items-baseline gap-2 font-medium">
              Result
              {output && (
                <span
                  className="text-text-tertiary text-xs font-normal"
                  data-tooltip={
                    received
                      ? 'The parent conversation recorded this result. Completion is not acceptance.'
                      : "Read from the agent's own record; delivery to the parent is not confirmed here."
                  }
                >
                  {received
                    ? `Received by parent${receivedAt ? ` · ${receivedAt}` : ''}`
                    : "From the agent's record"}
                </span>
              )}
            </h4>
            {output && <CopyButton text={output} />}
          </div>
          {output ? (
            <div className="max-h-96 overflow-auto break-words">
              <SubagentText text={output} />
            </div>
          ) : (
            <p className="text-text-tertiary text-xs">
              {loading && !inspection ? 'Reading result…' : 'No result reported yet.'}
            </p>
          )}
          {notification && (
            <details className="mt-2">
              <TooltipSummary className="text-text-secondary cursor-pointer text-xs">
                Parent was notified{receivedAt ? ` · ${receivedAt}` : ''}
              </TooltipSummary>
              <p className="text-text-tertiary py-1 text-xs">
                A notification can point to a saved file instead of carrying the answer.
              </p>
              <div className="max-h-64 overflow-auto">
                <CopyButton text={notification} />
                <SubagentText text={notification} />
              </div>
            </details>
          )}
        </section>
      )}
      <TaskSection input={input} />
      {inputs.length > 0 && (
        <details className="mb-3">
          <TooltipSummary className="text-text-secondary cursor-pointer text-xs">
            Later messages to the agent · {inputs.length}
          </TooltipSummary>
          <div className="max-h-64 space-y-3 overflow-auto pt-2">
            {inputs.map((message, i) => (
              <div key={i}>
                <CopyButton text={message.text} />
                <SubagentText text={message.text} />
              </div>
            ))}
          </div>
        </details>
      )}
      {records.length > 0 && (
        <details data-testid="subagent-activity">
          <TooltipSummary className="text-text-secondary cursor-pointer py-1 text-xs font-medium">
            All activity · {records.length} {records.length === 1 ? 'step' : 'steps'} · {calls} tool{' '}
            {calls === 1 ? 'call' : 'calls'}
          </TooltipSummary>
          <p className="text-text-tertiary py-1 text-xs">
            Oldest first. Times and call/result pairing are not reported.
          </p>
          <div className="divide-border divide-y">
            {records.map((record) => {
              const identity = JSON.stringify([record.message.role, record.message.text])
              const occurrence = occurrences.get(identity) ?? 0
              occurrences.set(identity, occurrence + 1)
              const literal = record.kind === 'call' || record.kind === 'output'
              return (
                <details key={`${identity}:${occurrence}`} data-testid="subagent-activity-record">
                  <TooltipSummary
                    className="flex cursor-pointer list-none items-baseline gap-1.5 py-1 [&::-webkit-details-marker]:hidden"
                    data-tooltip={record.message.text.slice(0, 240)}
                  >
                    <span aria-hidden className="text-text-tertiary w-2 shrink-0 text-xs">
                      ›
                    </span>
                    <RecordLine record={record} />
                  </TooltipSummary>
                  <div className="pb-2">
                    <div className="flex justify-end">
                      <CopyButton text={record.message.text} />
                    </div>
                    <div className="max-h-72 overflow-auto">
                      {literal ? (
                        <pre className="font-mono text-xs whitespace-pre-wrap break-words">
                          {record.message.text}
                        </pre>
                      ) : (
                        <SubagentText text={record.message.text} />
                      )}
                    </div>
                  </div>
                </details>
              )
            })}
          </div>
        </details>
      )}
      {inspection?.truncated && (
        <p className="text-text-tertiary mt-3 text-xs">Older activity was left out of this read.</p>
      )}
    </div>
  )
}
