import { TooltipButton } from '@/components/Tooltip'
import { useId, useState } from 'react'
import { SubagentWorkRow } from './SubagentWorkRow'
import { activityText, newestWork } from './subagentPresentation'
import { ChevronIcon } from '@/components/icons'
import { useChatStore } from '@/stores/chat'
import { useSessionBooting } from './BootingIndicator'
import { openForegroundSubagent, openSubagents } from './subagentView'
import { useCurrentWork, type WorkEntry } from './currentWork'
import { useNow } from './useNow'

/** Current evidence stays outside the scrolling transcript and the switchable pane. */
export function BackgroundWorkIndicator({ sessionId }: { sessionId: string }): React.JSX.Element {
  return <CurrentWorkSummary key={sessionId} sessionId={sessionId} />
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`

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
  const now = useNow(active > 0)
  // The agent that reported most recently: the one line that shows motion.
  const latest = current
    .filter((entry) => entry.active)
    .reduce<WorkEntry | undefined>(
      (best, entry) =>
        !best || (entry.lastActivityAt ?? 0) > (best.lastActivityAt ?? 0) ? entry : best,
      undefined,
    )
  const open = (entry: WorkEntry): void => {
    if (entry.runId) openSubagents(sessionId, entry.runId, entry.childId)
    else if (entry.toolCallId) openForegroundSubagent(sessionId, entry.toolCallId)
  }
  if (!entries.length && !incomplete) return <></>

  const headline = [
    active > 0 ? `${plural(active, 'agent')} working` : 'No agents working',
    attention > 0 && `${attention} ${attention === 1 ? 'needs' : 'need'} parent attention`,
    unknown.length > 0 && `${unknown.length} status unavailable`,
    incomplete && 'snapshot incomplete',
    `parent ${parentBusy ? 'working' : 'idle'}`,
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <div className="mx-auto w-full max-w-3xl px-1 pb-2" data-testid="background-work-indicator">
      <div className="bg-bg-secondary border-border rounded-lg border text-sm">
        <div className="flex min-w-0 items-center gap-2 px-2 py-1">
          <TooltipButton
            type="button"
            aria-label={expanded ? 'Collapse current work' : 'Expand current work'}
            aria-expanded={expanded}
            aria-controls={detailsId}
            onClick={() => setExpanded(!expanded)}
            className="text-text hover:bg-bg flex size-6 shrink-0 items-center justify-center rounded focus-visible:outline-2 focus-visible:outline-accent"
          >
            <ChevronIcon expanded={expanded} />
          </TooltipButton>
          {active > 0 && (
            <span
              aria-hidden
              className={`tool-running-dot size-2 shrink-0 rounded-full ${attention ? 'bg-warning' : 'bg-accent'}`}
            />
          )}
          <span className="text-text shrink-0 font-medium" role="status">
            {headline}
          </span>
          {/* Outside the live region: it changes with every tool call. */}
          <span
            data-testid="current-work-ticker"
            className="text-text-secondary min-w-0 flex-1 truncate text-xs"
          >
            {latest && !expanded && (
              <>
                {latest.title ?? latest.label} ·{' '}
                <span className={latest.currentTool ? 'tool-running-label' : undefined}>
                  {activityText(latest, now)}
                </span>
              </>
            )}
          </span>
          <TooltipButton
            type="button"
            onClick={() => openSubagents(sessionId)}
            className="text-text-secondary hover:text-text shrink-0 rounded px-1 py-0.5 text-xs underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-accent"
          >
            View subagents
          </TooltipButton>
        </div>
        <div
          id={detailsId}
          hidden={!expanded}
          className="border-border max-h-60 overflow-y-auto overscroll-contain border-t p-1"
        >
          {current.slice(0, 8).map((entry) => (
            <SubagentWorkRow key={entry.id} entry={entry} now={now} onClick={() => open(entry)} />
          ))}
          {current.length > 8 && (
            <p className="text-text-secondary px-2 py-1 text-xs">
              +{current.length - 8} more in the Subagents pane
            </p>
          )}
          {recent.length > 0 && (
            <>
              <p className="text-text-tertiary px-2 pt-1.5 text-xs">Recently finished</p>
              {recent.map((entry) => (
                <SubagentWorkRow
                  key={entry.id}
                  entry={entry}
                  now={now}
                  onClick={() => open(entry)}
                />
              ))}
            </>
          )}
          {(unknown.length > 0 || incomplete) && (
            <p className="text-text-tertiary px-2 py-1 text-xs">
              {unknown.length > 0 && 'Status unavailable means no current report, not finished. '}
              {incomplete && 'Some work was left out of the snapshot. '}
              {lastSeen && `Last report ${new Date(lastSeen).toLocaleTimeString()}.`}
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
