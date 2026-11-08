import { TooltipButton } from '@/components/Tooltip'
import { useId, useState } from 'react'
import clsx from 'clsx'
import { SubagentWorkRow, WORK_SECTION_CLASS } from './SubagentWorkRow'
import { activityText, newestWork } from './subagentPresentation'
import { ChevronIcon } from '@/components/icons'
import { useChatStore } from '@/stores/chat'
import { useSessionBooting } from './BootingIndicator'
import { openForegroundSubagent, openSubagents } from './subagentView'
import { useCurrentWork, type WorkEntry } from './currentWork'
import { useNow } from './useNow'
import { ComposerNotice, NOTICE_ACTION_CLASS, NOTICE_ICON_BUTTON_CLASS } from './ComposerNotice'

/** Current evidence stays outside the scrolling transcript and the switchable pane. */
export function BackgroundWorkIndicator({ sessionId }: { sessionId: string }): React.JSX.Element {
  return <CurrentWorkSummary key={sessionId} sessionId={sessionId} />
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`

function CurrentWorkSummary({ sessionId }: { sessionId: string }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const detailsId = useId()
  const { entries, incomplete, lastSeen, statusPaused } = useCurrentWork(sessionId)
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

  // "No agents working" is a claim; with unreported agents it is not one we can make.
  const headline = [
    active > 0
      ? `${plural(active, 'agent')} working`
      : unknown.length > 0
        ? plural(unknown.length, 'agent')
        : 'No agents working',
    attention > 0 && `${attention} ${attention === 1 ? 'needs' : 'need'} parent attention`,
    unknown.length > 0 &&
      (active > 0 ? `${unknown.length} status unavailable` : 'status unavailable'),
    incomplete && 'snapshot incomplete',
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <ComposerNotice
      testId="background-work-indicator"
      details={
        <div
          id={detailsId}
          hidden={!expanded}
          className="border-border max-h-60 overflow-y-auto overscroll-contain border-t p-1 text-base"
        >
          {current.slice(0, 8).map((entry) => (
            <SubagentWorkRow key={entry.id} entry={entry} now={now} onClick={() => open(entry)} />
          ))}
          {current.length > 8 && (
            <p className="text-text-secondary px-2 py-1 text-sm">
              +{current.length - 8} more in the Subagents pane
            </p>
          )}
          {recent.length > 0 && (
            <>
              {/* Not "finished": paused and stopped work is listed here too. */}
              <p className={WORK_SECTION_CLASS}>Recent</p>
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
            <p className="text-text-secondary px-2 py-1 text-sm">
              {unknown.length > 0 && 'Status unavailable means no current report, not finished. '}
              {statusPaused &&
                'pi-subagents stops reporting background work after an automatic compaction, until this parent turn ends. '}
              {incomplete && 'Some work was left out of the snapshot. '}
              {lastSeen && `Last report ${new Date(lastSeen).toLocaleTimeString()}.`}
            </p>
          )}
        </div>
      }
    >
      <TooltipButton
        type="button"
        aria-label={expanded ? 'Collapse current work' : 'Expand current work'}
        aria-expanded={expanded}
        aria-controls={detailsId}
        onClick={() => setExpanded(!expanded)}
        className={NOTICE_ICON_BUTTON_CLASS}
      >
        <ChevronIcon expanded={expanded} size={10} />
      </TooltipButton>
      {active > 0 && (
        <span
          aria-hidden
          className={`tool-running-dot size-1.5 shrink-0 rounded-full ${attention ? 'bg-warning' : 'bg-accent'}`}
        />
      )}
      {/* Only agent counts are announced; parent turns and the ticker are not. */}
      <span
        className={clsx('min-w-0 truncate', active > 0 && 'text-text')}
        data-testid="current-work-headline"
      >
        <span role="status">{headline}</span> · parent {parentBusy ? 'working' : 'idle'}
      </span>
      <span
        data-testid="current-work-ticker"
        className="text-text-tertiary min-w-0 flex-1 truncate"
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
        aria-label="View subagents"
        onClick={() => openSubagents(sessionId)}
        className={NOTICE_ACTION_CLASS}
      >
        {/* A narrow composer keeps the headline readable before the button's label. */}
        View<span className="@max-[30rem]:hidden"> subagents</span>
      </TooltipButton>
    </ComposerNotice>
  )
}
