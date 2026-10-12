import { useLayoutEffect, useRef, useState } from 'react'
import { CopyButton } from '@/components/CopyButton'
import { Button } from '@/components/form'
import { isScrollBackIntent, isScrollBackKey } from './items/autoscroll'
import type { SubagentInspection } from './subagentInspect'
import type { SupervisorHandoff } from './subagentPresentation'
import { SubagentText } from './SubagentText'

/** Handoff first. The wire's role/text messages cannot establish tool pairing or timing. */
export function SubagentPreview({
  inspection,
  handoff,
}: {
  inspection: SubagentInspection
  handoff?: SupervisorHandoff
}): React.JSX.Element {
  const scroller = useRef<HTMLDivElement>(null)
  const following = useRef(false)
  const [paused, setPaused] = useState(false)
  const pause = (): void => {
    following.current = false
    setPaused(true)
  }
  const latest = (): void => {
    following.current = true
    setPaused(false)
    if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight
  }
  useLayoutEffect(() => {
    if (following.current && scroller.current)
      scroller.current.scrollTop = scroller.current.scrollHeight
  }, [inspection])
  const input = handoff?.input ?? inspection.task
  const notification = handoff?.kind === 'notification' ? handoff.output : undefined
  const receivedOutput = handoff?.kind === 'notification' ? undefined : handoff?.output
  const output = receivedOutput ?? inspection.finalOutput
  const messages = inspection.messages.filter((m) => m.role !== 'user')
  const inputs = inspection.messages.filter((m) => m.role === 'user' && m.text !== input)
  const calls = messages.filter(
    (m) => m.role === 'assistant' && /^\[tool: [^\]\n]+\]$/.test(m.text.trim()),
  ).length
  const results = messages.filter((m) => m.role.toLowerCase() === 'toolresult').length
  const occurrences = new Map<string, number>()
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scroller}
        data-testid="subagent-transcript"
        aria-label="Subagent activity"
        tabIndex={0}
        className="min-h-0 flex-1 overflow-auto overscroll-contain p-3 text-sm [overflow-anchor:none]"
        onWheel={(event) => {
          if (isScrollBackIntent(event.deltaY)) pause()
        }}
        onKeyDown={(event) => {
          if (isScrollBackKey(event.key)) pause()
        }}
        onScroll={() => {
          const el = scroller.current
          if (el && el.scrollHeight - el.scrollTop - el.clientHeight > 96 && following.current)
            pause()
        }}
      >
        <section className="border-border mb-3 border-b pb-3" aria-label="Agent input">
          <div className="mb-2 flex items-center justify-between gap-2">
            <h4 className="font-medium">Input · delegated task</h4>
            {input && <CopyButton text={input} />}
          </div>
          <div className="max-h-56 overflow-auto break-words text-base">
            {input ? (
              <SubagentText text={input} />
            ) : (
              <p className="text-text-secondary text-sm">
                Task not reported in the available evidence.
              </p>
            )}
          </div>
          {inputs.length > 0 && (
            <details
              className="mt-2"
              onToggle={(e) => {
                if (e.currentTarget.open) pause()
              }}
            >
              <summary className="text-text-secondary cursor-pointer">
                Additional input in preview · {inputs.length}{' '}
                {inputs.length === 1 ? 'message' : 'messages'}
              </summary>
              <div className="max-h-64 space-y-3 overflow-auto pt-2 text-base">
                {inputs.map((message, i) => (
                  <div key={i}>
                    <CopyButton text={message.text} />
                    <SubagentText text={message.text} />
                  </div>
                ))}
              </div>
            </details>
          )}
        </section>
        <section className="border-border mb-3 border-b pb-3" aria-label="Agent output">
          <div className="mb-2 flex items-center justify-between gap-2">
            <h4 className="font-medium">
              {receivedOutput ? 'Output received by supervisor' : 'Reported result'}
            </h4>
            {output && <CopyButton text={output} />}
          </div>
          <p className="text-text-tertiary mb-2 text-xs">
            {receivedOutput
              ? `Parent conversation receipt${handoff?.receivedAt !== undefined && Number.isFinite(handoff.receivedAt) ? ` · Received ${new Date(handoff.receivedAt).toLocaleString()}` : ''}. Completion is not acceptance.`
              : 'Inspection evidence only; delivery to the supervisor is not confirmed here.'}
          </p>
          <div className="max-h-80 overflow-auto break-words text-base">
            {output ? (
              <SubagentText text={output} />
            ) : (
              <p className="text-text-secondary text-sm">
                No final output in this bounded preview.
              </p>
            )}
          </div>
          {notification && (
            <details
              className="mt-2"
              onToggle={(e) => {
                if (e.currentTarget.open) pause()
              }}
            >
              <summary className="text-text-secondary cursor-pointer">
                Supervisor received notification
              </summary>
              <p className="text-text-tertiary py-1 text-xs">
                A notification may contain an artifact reference rather than the full answer.
                {handoff?.receivedAt !== undefined &&
                  Number.isFinite(handoff.receivedAt) &&
                  ` Received ${new Date(handoff.receivedAt).toLocaleString()}.`}
              </p>
              <div className="max-h-64 overflow-auto">
                <CopyButton text={notification} />
                <SubagentText text={notification} />
              </div>
            </details>
          )}
        </section>
        <details
          data-testid="subagent-activity"
          onToggle={(e) => {
            if (e.currentTarget.open) pause()
          }}
        >
          <summary className="text-text-secondary cursor-pointer py-1 font-medium">
            Activity · {calls} tool {calls === 1 ? 'call' : 'calls'} · {results}{' '}
            {results === 1 ? 'output' : 'outputs'} · {messages.length - calls - results}{' '}
            {messages.length - calls - results === 1 ? 'message' : 'messages'}
          </summary>
          <p className="text-text-tertiary py-1 text-xs">
            Chronological preview. Per-message timing and call/result pairing are not reported.
          </p>
          <div className="divide-border divide-y">
            {messages.map((message) => {
              const identity = JSON.stringify([message.role, message.text])
              const occurrence = occurrences.get(identity) ?? 0
              occurrences.set(identity, occurrence + 1)
              const call =
                message.role === 'assistant'
                  ? /^\[tool: ([^\]\n]+)\]$/.exec(message.text.trim())
                  : null
              const literal = message.role.toLowerCase() === 'toolresult' || !!call
              const label = call
                ? `Tool call · ${call[1]}`
                : literal
                  ? 'Tool output'
                  : message.role === 'assistant'
                    ? 'Agent message'
                    : message.role === 'thinking'
                      ? 'Thinking'
                      : message.role
              return (
                <details
                  key={`${identity}:${occurrence}`}
                  data-testid="subagent-activity-record"
                  onToggle={(e) => {
                    if (e.currentTarget.open) pause()
                  }}
                >
                  <summary
                    className="text-text-secondary cursor-pointer truncate py-1.5"
                    title={message.text.slice(0, 240)}
                  >
                    <span className="font-medium">{label}</span>
                    {!call && (
                      <span className="text-text-tertiary">
                        {' '}
                        · {message.text.replace(/\s+/g, ' ').slice(0, 160)}
                      </span>
                    )}
                  </summary>
                  <div className="pb-2">
                    <div className="flex justify-end">
                      <CopyButton text={message.text} />
                    </div>
                    <div className="max-h-72 overflow-auto">
                      {literal ? (
                        <pre className="font-mono text-xs whitespace-pre-wrap break-words">
                          {message.text}
                        </pre>
                      ) : (
                        <SubagentText text={message.text} />
                      )}
                    </div>
                  </div>
                </details>
              )
            })}
          </div>
        </details>
        {inspection.truncated && (
          <p className="text-text-secondary mt-3 text-xs">
            Bounded preview: some content was omitted.
          </p>
        )}
        {!inspection.messages.length && !output && (
          <p className="text-text-secondary mt-2 text-xs">No output in this preview.</p>
        )}
      </div>
      {paused && (
        <div className="border-border flex shrink-0 items-center justify-between gap-2 border-t px-3 py-1">
          <span className="text-text-secondary text-sm">Following paused</span>
          <Button size="sm" onClick={latest}>
            Jump to latest
          </Button>
        </div>
      )}
    </div>
  )
}
