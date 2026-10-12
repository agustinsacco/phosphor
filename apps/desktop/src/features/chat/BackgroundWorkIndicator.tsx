import { PhosphorLoader } from '@/components/PhosphorLoader'
import { useChatStore } from '@/stores/chat'
import { useSessionBooting } from './BootingIndicator'
import { openForegroundSubagent, openSubagents } from './subagentView'
import { useCurrentWork, type WorkEntry } from './currentWork'

/** Current evidence stays outside the scrolling transcript and the switchable pane. */
export function BackgroundWorkIndicator({ sessionId }: { sessionId: string }): React.JSX.Element {
  const { entries, incomplete, lastSeen } = useCurrentWork(sessionId)
  const parentRunning = useChatStore(
    (s) => !!(s.sessions[sessionId]?.isStreaming || s.sessions[sessionId]?.isCompacting),
  )
  const booting = useSessionBooting(sessionId)
  const parentBusy = parentRunning || booting
  const active = entries.reduce((sum, entry) => sum + entry.active, 0)
  const attention = entries.filter((entry) => entry.active && entry.attention).length
  const unknown = entries.filter((entry) => entry.state === 'status unavailable')
  const current = [...entries.filter((entry) => entry.active), ...unknown.slice().reverse()]
  const recent = entries.filter((entry) => !current.includes(entry)).slice(-3)
  const open = (entry: WorkEntry): void => {
    if (entry.runId) openSubagents(sessionId, entry.runId, entry.childId)
    else if (entry.toolCallId) openForegroundSubagent(sessionId, entry.toolCallId)
  }
  if (!entries.length && !incomplete) return <></>

  return (
    <div className="mx-auto w-full max-w-3xl px-1 pb-2" data-testid="background-work-indicator">
      <div className="bg-bg-secondary border-border flex items-start gap-2 rounded-lg border px-3 py-2 text-base">
        {!parentBusy && active > 0 && <PhosphorLoader decorative animated />}
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
            <span className="text-text font-medium" role="status">
              {parentBusy ? 'Parent working' : 'Parent idle'} · {active} subagents active
              {attention > 0 && ` · ${attention} needs parent attention`}
            </span>
            <button
              type="button"
              onClick={() => openSubagents(sessionId)}
              className="text-text-secondary hover:text-text shrink-0 rounded px-1 py-0.5 underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-accent"
            >
              View subagents
            </button>
          </div>
          {(unknown.length > 0 || incomplete) && (
            <p className="text-text-secondary text-sm">
              {unknown.length > 0 && 'Status unavailable for some work. '}
              {incomplete && 'Snapshot incomplete; some work may not be shown. '}
              {lastSeen && `Last snapshot received ${new Date(lastSeen).toLocaleTimeString()}. `}
              Active count includes only currently reported work.
            </p>
          )}
          <div className="max-h-32 overflow-y-auto overscroll-contain">
            {current.slice(0, 8).map((entry) => (
              <button
                key={entry.id}
                type="button"
                onClick={() => open(entry)}
                className="text-text-secondary hover:text-text block w-full truncate rounded text-left text-sm underline underline-offset-2"
              >
                {entry.label}: {entry.state}
                {entry.currentTool ? ` · ${entry.currentTool}` : ''}
                {entry.active > 0 && entry.attention ? ' · needs parent attention' : ''}
              </button>
            ))}
            {current.length > 8 && (
              <p className="text-text-secondary text-sm">
                +{current.length - 8} more in the pane or conversation
              </p>
            )}
          </div>
          {recent.length > 0 && (
            <details className="text-text-secondary text-sm">
              <summary className="cursor-pointer">
                Recent work · completion is not acceptance
              </summary>
              {recent.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  onClick={() => open(entry)}
                  className="hover:text-text block w-full truncate rounded text-left underline"
                >
                  {entry.label}: {entry.state}
                </button>
              ))}
            </details>
          )}
          <p className="text-text-secondary text-sm">
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
