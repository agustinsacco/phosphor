import clsx from 'clsx'
import { TooltipButton } from '@/components/Tooltip'
import { piCallOk } from '@/lib/rpc'
import { useCanControlSession } from '@/features/sessions/useCanControlSession'
import type { BashItem } from '../reducer'
import { SEGMENT } from '../transcriptFind'

/**
 * Stop for a running `!command`, or one a Host could not confirm (it may still
 * be running there). pi's `abort` does not stop a shell; `abort_bash` does, and
 * is harmless when nothing runs. Only whoever may command the lane sees it.
 */
function StopShell({ sessionId }: { sessionId: string }): React.JSX.Element | null {
  if (!useCanControlSession(sessionId)) return null
  return (
    <TooltipButton
      onClick={() => void piCallOk(sessionId, { type: 'abort_bash' })}
      title="Stop this command"
      className="text-text-tertiary hover:text-text rounded px-1.5 py-px text-sm hover:underline"
    >
      Stop
    </TooltipButton>
  )
}

/** A `!`/`!!` bash execution the user ran from the composer. */
export function BashExecution({
  item,
  sessionId,
}: {
  item: BashItem
  sessionId: string
}): React.JSX.Element {
  return (
    <div className="border-border bg-surface overflow-hidden rounded-lg border">
      <div className="border-border flex items-center justify-between gap-2 border-b px-3 py-2">
        <code className="text-text flex-1 truncate font-mono text-base">
          <span className="text-accent font-semibold" data-find-skip>
            !
          </span>{' '}
          <span data-find-segment={SEGMENT.command}>{item.command}</span>
        </code>
        <div className="flex shrink-0 items-center gap-2">
          {item.excludeFromContext && (
            <span className="bg-bg-secondary text-text-tertiary rounded px-1.5 py-px text-xs">
              not sent to model
            </span>
          )}
          {(item.running || item.unconfirmed) && <StopShell sessionId={sessionId} />}
          {item.running ? (
            <span className="text-text-tertiary text-sm">running…</span>
          ) : item.unconfirmed ? (
            <span className="text-warning text-sm">unconfirmed</span>
          ) : (
            <span
              className={clsx(
                'rounded px-1.5 py-px font-mono text-xs font-medium',
                item.exitCode === 0 ? 'bg-success/15 text-success' : 'bg-danger-soft text-danger',
              )}
            >
              exit {item.exitCode ?? '?'}
            </span>
          )}
        </div>
      </div>
      <pre
        data-find-segment={SEGMENT.output}
        className="max-h-72 overflow-auto px-3 py-2.5 font-mono text-base leading-relaxed break-words whitespace-pre-wrap"
      >
        {item.output || <span data-find-skip>{item.running ? '…' : '(no output)'}</span>}
      </pre>
      {item.truncated && item.fullOutputPath && (
        <div className="border-border text-text-tertiary border-t px-3 py-1.5 text-sm">
          Truncated — full output at <code className="font-mono">{item.fullOutputPath}</code>
        </div>
      )}
    </div>
  )
}
