import { useLayoutEffect, useRef, useState } from 'react'
import { Markdown } from '@/components/markdown/Markdown'
import { CopyButton } from '@/components/CopyButton'
import { Button } from '@/components/form'
import { isScrollBackIntent, isScrollBackKey } from './items/autoscroll'
import type { SubagentInspection } from './subagentInspect'

/** A bounded preview, not a synthetic ToolState: the wire has no call/result IDs. */
export function SubagentPreview({
  inspection,
}: {
  inspection: SubagentInspection
}): React.JSX.Element {
  const scroller = useRef<HTMLDivElement>(null)
  const following = useRef(true)
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
  const occurrences = new Map<string, number>()
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scroller}
        data-testid="subagent-transcript"
        aria-label="Subagent activity"
        tabIndex={0}
        className="min-h-0 flex-1 overflow-auto overscroll-contain p-4 text-base [overflow-anchor:none]"
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
        {inspection.task && (
          <details className="border-border mb-4 border-b pb-3">
            <summary className="text-text-secondary cursor-pointer font-medium">
              Delegated task
            </summary>
            <Markdown text={inspection.task} inAppLinks={false} />
          </details>
        )}
        <h4 className="text-text-secondary mb-3 text-sm font-medium">Recent activity</h4>
        <div className="space-y-3">
          {inspection.messages.map((message) => {
            // Content keys keep disclosures attached to the same record when
            // the extension's bounded window drops messages from its head.
            const identity = JSON.stringify([message.role, message.text])
            const occurrence = occurrences.get(identity) ?? 0
            occurrences.set(identity, occurrence + 1)
            const call = /^\[tool: ([^\]\n]+)\]$/.exec(message.text.trim())
            if (message.role === 'assistant' && !call)
              return (
                <div key={`${identity}:${occurrence}`} className="min-w-0 break-words">
                  <Markdown text={message.text} inAppLinks={false} />
                </div>
              )
            const label = call
              ? `Tool call · ${call[1]}`
              : message.role.toLowerCase() === 'toolresult'
                ? 'Tool output'
                : message.role
            return (
              <details
                key={`${identity}:${occurrence}`}
                className="border-border bg-bg-secondary/40 rounded-md border"
                onToggle={(event) => {
                  if (event.currentTarget.open) pause()
                }}
              >
                <summary className="cursor-pointer px-3 py-2 text-text-secondary">
                  <span className="font-medium">{label}</span>
                  {!call && (
                    <span className="mt-1 block truncate font-mono text-sm">
                      {message.text.split('\n')[0]}
                    </span>
                  )}
                </summary>
                <div className="border-border border-t">
                  <div className="flex justify-end px-2 pt-1">
                    <CopyButton text={message.text} />
                  </div>
                  <pre className="max-h-80 overflow-auto px-3 pb-3 font-mono text-sm whitespace-pre-wrap break-words">
                    {message.text}
                  </pre>
                </div>
              </details>
            )
          })}
        </div>
        {inspection.finalOutput && (
          <section className="border-border mt-4 border-t pt-3">
            <h4 className="mb-2 font-medium">Result</h4>
            <Markdown text={inspection.finalOutput} inAppLinks={false} />
          </section>
        )}
        {inspection.truncated && (
          <p className="text-text-secondary mt-4 text-sm">
            Bounded preview: some content was omitted.
          </p>
        )}
        {!inspection.messages.length && !inspection.finalOutput && (
          <p className="text-text-secondary">No output in this preview.</p>
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
