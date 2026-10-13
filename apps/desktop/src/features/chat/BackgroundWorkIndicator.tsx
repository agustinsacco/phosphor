import { TooltipButton, TooltipSummary } from '@/components/Tooltip'
import { useId, useState } from 'react'
import { SubagentWorkRow } from './SubagentWorkRow'
import { newestWork } from './subagentPresentation'
import { ChevronIcon } from '@/components/icons'
import { PhosphorLoader } from '@/components/PhosphorLoader'
import { useChatStore } from '@/stores/chat'
import { useSessionBooting } from './BootingIndicator'
import { openForegroundSubagent, openSubagents } from './subagentView'
import { useCurrentWork, type WorkEntry } from './currentWork'

/** Current evidence stays outside the scrolling transcript and the switchable pane. */
export function BackgroundWorkIndicator({ sessionId }: { sessionId: string }): React.JSX.Element {
  return <CurrentWorkSummary key={sessionId} sessionId={sessionId} />
}

function CurrentWorkSummary({ sessionId }: { sessionId: string }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const detailsId = useId()
  const { entries, incomplete, lastSeen } = useCurrentWork(sessionId)
  const parentRunning = useChatStore(
    (s) => !!(s.sessions[sessionId]?.isStreaming || s.sessions[sessionId]?.isCompacting),
  )
  const booting = useSessionBooting(sessionId)
  const parentBusy = parentRunning || booting
  const active = entries.reduce((sum, entry) => sum + entry.active, 0)
  const attention = entries.filter((entry) => entry.active && entry.attention).length
  const unknown = entries.filter((entry) => entry.state === 'status unavailable')
  const current = newestWork(entries.filter((entry) => entry.active || unknown.includes(entry)))
  const recent = newestWork(entries.filter((entry) => !current.includes(entry))).slice(0, 3)
  const open = (entry: WorkEntry): void => {
    if (entry.runId) openSubagents(sessionId, entry.runId, entry.childId)
    else if (entry.toolCallId) openForegroundSubagent(sessionId, entry.toolCallId)
  }
  if (!entries.length && !incomplete) return <></>

  return (
    <div className="mx-auto w-full max-w-3xl px-1 pb-2" data-testid="background-work-indicator">
      <div className="bg-bg-secondary border-border rounded-lg border px-3 py-1.5 text-sm">
        <div className="flex items-start gap-2">
          {!parentBusy && active > 0 && <PhosphorLoader decorative animated />}
          <TooltipButton
            type="button"
            aria-label={expanded ? 'Collapse current work' : 'Expand current work'}
            aria-expanded={expanded}
            aria-controls={detailsId}
            onClick={() => setExpanded(!expanded)}
            className="text-text hover:bg-bg -ml-1 flex size-6 shrink-0 items-center justify-center rounded focus-visible:outline-2 focus-visible:outline-accent"
          >
            <ChevronIcon expanded={expanded} />
          </TooltipButton>
          <span className="text-text min-w-0 flex-1 py-0.5 font-medium" role="status">
            {parentBusy ? 'Parent working' : 'Parent idle'} · {active} subagents active
            {attention > 0 && ` · ${attention} needs parent attention`}
            {unknown.length > 0 && ` · Status unavailable (${unknown.length})`}
            {incomplete && ' · Snapshot incomplete'}
            {!current.length && recent.length > 0 && ' · Recent work'}
          </span>
          <TooltipButton
            type="button"
            onClick={() => openSubagents(sessionId)}
            className="text-text-secondary hover:text-text shrink-0 rounded px-1 py-0.5 underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-accent"
          >
            View subagents
          </TooltipButton>
        </div>
        <div id={detailsId} hidden={!expanded} className="mt-1">
          {(unknown.length > 0 || incomplete) && (
            <p className="text-text-secondary px-2 py-1 text-xs">
              {unknown.length > 0 && 'Status unavailable for some work. '}
              {incomplete && 'Snapshot incomplete; some work may not be shown. '}
              {lastSeen && `Last snapshot received ${new Date(lastSeen).toLocaleTimeString()}. `}
              Active count includes only currently reported work.
            </p>
          )}
          <div className="max-h-48 overflow-y-auto overscroll-contain">
            {current.length > 0 && (
              <p className="text-text-tertiary px-2 py-1 text-xs">Current work · newest first</p>
            )}
            {current.slice(0, 8).map((entry) => (
              <SubagentWorkRow key={entry.id} entry={entry} onClick={() => open(entry)} />
            ))}
            {current.length > 8 && (
              <p className="text-text-secondary text-sm">
                +{current.length - 8} more in the pane or conversation
              </p>
            )}
          </div>
          {recent.length > 0 && (
            <details className="text-text-secondary mt-1 border-t border-border pt-1 text-xs">
              <TooltipSummary className="cursor-pointer">
                Recent work · completion is not acceptance
              </TooltipSummary>
              {recent.map((entry) => (
                <SubagentWorkRow key={entry.id} entry={entry} onClick={() => open(entry)} />
              ))}
            </details>
          )}
          <p className="text-text-tertiary px-2 pt-2 text-xs">
            {parentBusy
              ? 'Messages still go to the parent, not a child.'
              : 'The parent is idle. You can still message it.'}
            {attention > 0 && ' Attention signals are for the parent.'}
          </p>
        </div>
      </div>
    </div>
  )
}
