import { TooltipButton, TooltipSummary } from '@/components/Tooltip'
import { useState } from 'react'
import clsx from 'clsx'
import type { CustomItem } from '../reducer'
import { parseSubagentNotice, shortId, type SubagentNotice } from '../subagentRuns'
import { Markdown } from '@/components/markdown/Markdown'
import { ChevronIcon } from '@/components/icons'
import { SEGMENT } from '../transcriptFind'

/**
 * A background run reporting back, where the model woke up to read it.
 *
 * pi-subagents delivers the completion as a custom message and marks a plain
 * success `display: false` so its TUI does not badge an idle tab. Phosphor
 * shows it anyway: the reply that follows quotes this result, and a reader
 * could not see why the model spoke again. Every notice starts as one line —
 * who, what happened, when — with the output, signal and identifiers behind
 * the disclosure. A failure keeps its warning tone while folded. When the
 * notice names exactly one native run, **Inspect run** opens it in the
 * Subagents pane without unfolding the card.
 */
export function SubagentNoticeItem({
  item,
  onInspect,
  reply,
}: {
  item: CustomItem
  onInspect?: (runId: string) => void
  reply?: string
}): React.JSX.Element {
  const notice: SubagentNotice = parseSubagentNotice(item.customType, item.text, item.details) ?? {
    kind: 'completion' as const,
    agents: [],
    headline: item.customType ?? 'Sub-agent notice',
    body: item.text,
  }
  const timestamp = item.timestamp === undefined ? undefined : new Date(item.timestamp)
  const validTime = timestamp && Number.isFinite(timestamp.getTime()) ? timestamp : undefined
  const [open, setOpen] = useState(false)
  const request = item.details as { requestBody?: unknown } | undefined
  const questionBody =
    notice.kind === 'question' && typeof request?.requestBody === 'string'
      ? request.requestBody
      : undefined
  const runs = notice.runs ?? []
  const identity = !!(notice.runId || notice.workflowRunId || notice.requestId || runs.length > 1)
  const expandable = !!(notice.body || notice.summary || reply !== undefined || identity)
  const tone =
    notice.kind === 'attention' || notice.kind === 'question' || notice.status === 'failed'
      ? 'warning'
      : notice.status === 'stopped'
        ? 'stopped'
        : 'calm'
  const inspect = (runId: string, label: string): React.JSX.Element | null =>
    onInspect ? (
      <TooltipButton
        tooltip={{ label: 'Open this run in the Subagents pane', description: runId }}
        className="text-accent shrink-0 rounded px-1 text-sm hover:underline"
        onClick={() => onInspect(runId)}
      >
        {label}
      </TooltipButton>
    ) : null

  return (
    <div
      data-testid="subagent-notice"
      data-kind={notice.kind}
      data-status={notice.status}
      className={clsx(
        'rounded-lg border px-2 py-1',
        tone === 'warning'
          ? 'border-warning/30 bg-[color-mix(in_srgb,var(--px-warning)_6%,transparent)]'
          : 'border-border/60',
      )}
    >
      <div className="flex min-w-0 items-center gap-1">
        <TooltipButton
          onClick={() => expandable && setOpen(!open)}
          tooltip={expandable ? (open ? 'Hide details' : 'Show details') : false}
          aria-expanded={expandable ? open : undefined}
          disabled={!expandable}
          className={clsx(
            'flex min-w-0 flex-1 items-center gap-2 rounded-md py-0.5 pr-1 text-left text-base',
            expandable && 'hover:bg-bg-secondary/60',
          )}
        >
          <span className="flex w-3 shrink-0 justify-center">
            {expandable && (
              <ChevronIcon
                expanded={open}
                size={9}
                strokeWidth={3}
                className="text-text-tertiary"
              />
            )}
          </span>
          <span
            className={clsx(
              'shrink-0 rounded px-1.5 py-px text-xs font-semibold uppercase tracking-wide',
              tone === 'warning'
                ? 'bg-bg-secondary text-warning'
                : tone === 'stopped'
                  ? 'bg-bg-secondary text-text-secondary'
                  : 'bg-accent-soft text-accent',
            )}
          >
            agent
          </span>
          <span className="text-text min-w-0 flex-1 break-words font-medium">
            {notice.headline}
            {reply !== undefined ? ' · parent replied' : ''}
          </span>
          {validTime && (
            <time
              dateTime={validTime.toISOString()}
              className="text-text-tertiary shrink-0 text-sm tabular-nums"
            >
              {validTime.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
            </time>
          )}
        </TooltipButton>
        {notice.runId && inspect(notice.runId, 'Inspect run')}
      </div>
      {open && expandable && (
        <div
          data-testid="subagent-notice-body"
          data-find-segment={SEGMENT.body}
          className="mt-1 mb-1 ml-5 space-y-1.5 text-base"
        >
          {notice.summary && <p className="text-text-secondary">{notice.summary}</p>}
          {identity && (
            <div className="text-text-secondary flex flex-wrap items-center gap-x-3 font-mono text-sm">
              {notice.runId && (
                <span data-tooltip={notice.runId}>
                  run {shortId(notice.runId)}
                  {notice.childIndex !== undefined ? ` · child ${notice.childIndex}` : ''}
                </span>
              )}
              {runs.length > 1 &&
                runs.map((run) => (
                  <span key={run.runId} className="flex items-center gap-1">
                    <span data-tooltip={run.runId}>
                      {run.agent ? `${run.agent} ` : ''}run {shortId(run.runId)}
                    </span>
                    {inspect(run.runId, 'Inspect')}
                  </span>
                ))}
              {notice.workflowRunId && (
                <span data-tooltip={notice.workflowRunId}>
                  workflow {shortId(notice.workflowRunId)}
                </span>
              )}
              {notice.requestId && (
                <span data-tooltip={notice.requestId}>request {shortId(notice.requestId)}</span>
              )}
            </div>
          )}
          {(questionBody ?? notice.body) && (
            <div className="border-accent/30 max-h-[28rem] overflow-auto border-l-2 pl-3">
              <Markdown text={questionBody ?? notice.body} />
            </div>
          )}
          {reply !== undefined && (
            <section className="border-border border-t pt-2">
              <h4 className="font-medium">Parent’s recorded reply</h4>
              <Markdown text={reply} />
              <p className="text-text-secondary">A reply is not proof the child acted on it.</p>
            </section>
          )}
          {questionBody && (
            <details>
              <TooltipSummary className="cursor-pointer">Original notice</TooltipSummary>
              <Markdown text={notice.body} />
            </details>
          )}
        </div>
      )}
    </div>
  )
}
