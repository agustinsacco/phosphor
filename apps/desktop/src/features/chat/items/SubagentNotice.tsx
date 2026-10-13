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
 * shows it anyway, compactly: the reply that follows quotes this result, and
 * a reader could not see why the model spoke again. A success stays folded;
 * failures and stops open. Structured attention notices keep their signal
 * visible while folding the original diagnostic commands underneath.
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
  const calm = notice.kind === 'completion' && notice.status === 'completed'
  const [chosen, setChosen] = useState<boolean>()
  const open = chosen ?? (reply === undefined && !calm && !notice.summary)
  const request = item.details as { requestBody?: unknown } | undefined
  const questionBody =
    notice.kind === 'question' && typeof request?.requestBody === 'string'
      ? request.requestBody
      : undefined
  const expandable = notice.body.length > 0
  const tone =
    notice.kind === 'attention' || notice.kind === 'question' || notice.status === 'failed'
      ? 'warning'
      : notice.status === 'stopped'
        ? 'stopped'
        : 'calm'

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
      <TooltipButton
        onClick={() => expandable && setChosen(!open)}
        tooltip={expandable ? (open ? 'Hide notice' : 'Show notice') : false}
        aria-expanded={expandable ? open : undefined}
        disabled={!expandable}
        className={clsx(
          'flex w-full items-center gap-2 py-0.5 text-left text-base',
          expandable && 'hover:bg-bg-secondary/60 rounded-md',
        )}
      >
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
        <span className="text-text min-w-0 break-words font-medium">
          {notice.headline}
          {reply !== undefined ? ' · parent replied' : ''}
        </span>
        {expandable && (
          <ChevronIcon
            expanded={open}
            size={9}
            strokeWidth={3}
            className="text-text-tertiary ml-auto"
          />
        )}
      </TooltipButton>
      {notice.summary && (
        <p className="text-text-secondary px-1 py-1 text-base">{notice.summary}</p>
      )}
      {(notice.runId || notice.requestId) && (
        <div className="text-text-secondary flex flex-wrap gap-x-3 px-1 py-1 font-mono text-sm">
          {notice.runId && (
            <span data-tooltip={notice.runId}>
              run {shortId(notice.runId)}
              {notice.childIndex !== undefined ? ` · child ${notice.childIndex}` : ''}
            </span>
          )}
          {notice.workflowRunId && (
            <span data-tooltip={notice.workflowRunId}>
              workflow {shortId(notice.workflowRunId)}
            </span>
          )}
          {notice.runId && onInspect && (
            <TooltipButton
              className="text-accent hover:underline"
              onClick={() => onInspect(notice.runId!)}
            >
              Inspect run
            </TooltipButton>
          )}
          {notice.requestId && (
            <span data-tooltip={notice.requestId}>request {shortId(notice.requestId)}</span>
          )}
          {validTime && (
            <time dateTime={validTime.toISOString()}>{validTime.toLocaleTimeString()}</time>
          )}
        </div>
      )}
      {open && expandable && (
        <div
          data-testid="subagent-notice-body"
          data-find-segment={SEGMENT.body}
          className="border-accent/30 mt-1 mb-1 ml-1 max-h-[28rem] overflow-auto border-l-2 pl-3 text-base"
        >
          <Markdown text={questionBody ?? notice.body} />
          {reply !== undefined && (
            <section className="border-border mt-3 border-t pt-2">
              <h4 className="font-medium">Parent’s recorded reply</h4>
              <Markdown text={reply} />
              <p className="text-text-secondary">A reply is not proof the child acted on it.</p>
            </section>
          )}
          {questionBody && (
            <details className="mt-2">
              <TooltipSummary className="cursor-pointer">Original notice</TooltipSummary>
              <Markdown text={notice.body} />
            </details>
          )}
        </div>
      )}
    </div>
  )
}
