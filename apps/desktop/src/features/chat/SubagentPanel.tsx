import { useEffect, useState } from 'react'
import { ModalOverlay, ModalPanel } from '@/components/Modal'
import { Button } from '@/components/form'
import { Markdown } from '@/components/markdown/Markdown'
import { useExtensionUiStore } from '@/stores/extensionUi'
import { errorText } from '@shared/errors'
import { parseFleetWidget, SUBAGENT_ASYNC_WIDGET_KEY, type FleetNode } from './subagentRuns'
import { inspectSubagent, type SubagentInspection } from './subagentInspect'
import { SubagentJournal } from './SubagentJournal'
import { SubagentStop } from './SubagentStopControl'

export function SubagentPanel({
  sessionId,
  onClose,
  initialRunId,
}: {
  sessionId: string
  onClose: () => void
  initialRunId?: string
}): React.JSX.Element {
  const lines = useExtensionUiStore((s) => s.widgets[sessionId]?.[SUBAGENT_ASYNC_WIDGET_KEY]?.lines)
  const fleet = parseFleetWidget(lines)
  const [view, setView] = useState<'live' | 'history'>('live')
  const [target, setTarget] = useState<{ runId: string; childId?: string } | undefined>(
    initialRunId ? { runId: initialRunId } : undefined,
  )
  const [inspection, setInspection] = useState<SubagentInspection>()
  const [error, setError] = useState<string>()
  const [refresh, setRefresh] = useState(0)
  useEffect(() => {
    setInspection(undefined)
    setError(undefined)
    if (!target || view !== 'live') return
    const controller = new AbortController()
    void inspectSubagent(sessionId, target.runId, target.childId, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) setInspection(result)
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted) setError(errorText(err))
      })
    return () => controller.abort()
  }, [sessionId, target, refresh, view])

  const node = (entry: FleetNode, root: string, depth = 0): React.JSX.Element => (
    <li key={entry.id}>
      <button
        className="hover:bg-bg-secondary aria-pressed:bg-bg-secondary text-text flex w-full flex-wrap items-center gap-x-2 rounded-md px-2 py-2 text-left text-base"
        aria-pressed={target?.runId === root && target.childId === (depth ? entry.id : undefined)}
        onClick={() => setTarget({ runId: root, ...(depth ? { childId: entry.id } : {}) })}
      >
        <span className="min-w-0 truncate font-medium" title={entry.label}>
          {entry.label}
        </span>
        <span className="text-text-secondary font-mono text-sm">{entry.state}</span>
        {entry.attention && (
          <span className="text-text-secondary text-sm">needs parent attention</span>
        )}
        {entry.currentTool && (
          <span className="text-text-secondary w-full truncate font-mono text-sm">
            {entry.currentTool}
          </span>
        )}
      </button>
      {entry.children.length > 0 && (
        <ul className="border-border ml-3 border-l pl-2">
          {entry.children.map((child) => node(child, root, depth + 1))}
        </ul>
      )}
    </li>
  )

  return (
    <ModalOverlay onClose={onClose}>
      <section role="dialog" aria-modal="true" aria-label="Subagents">
        <ModalPanel
          width={900}
          title="Subagents"
          subtitle="This lane · read-only inspection · Pi owns execution"
          footer={<Button onClick={onClose}>Close</Button>}
        >
          <div className="border-border flex gap-2 border-b px-4 py-2" aria-label="Subagent views">
            <Button size="sm" aria-pressed={view === 'live'} onClick={() => setView('live')}>
              Live work
            </Button>
            <Button size="sm" aria-pressed={view === 'history'} onClick={() => setView('history')}>
              Recorded coordination
            </Button>
          </div>
          {view === 'history' && (
            <SubagentJournal
              sessionId={sessionId}
              onInspect={(runId) => {
                setTarget({ runId })
                setView('live')
              }}
            />
          )}
          <div
            className={
              view === 'live'
                ? 'grid max-h-[70vh] min-h-48 overflow-auto md:grid-cols-[16rem_minmax(0,1fr)]'
                : 'hidden'
            }
          >
            <div className="border-border border-b p-3 md:border-r md:border-b-0">
              <h3 className="text-text-secondary mb-2 font-mono text-xs uppercase tracking-wider">
                Background runs
              </h3>
              {fleet?.runs.length ? (
                <ul>{fleet.runs.map((run) => node(run, run.id))}</ul>
              ) : (
                <p className="text-text-secondary text-base">
                  No live snapshot. Recorded results remain in the conversation.
                </p>
              )}
              {!!fleet?.omittedRuns && (
                <p className="text-text-secondary mt-2 text-sm">
                  {fleet.omittedRuns} additional runs not shown.
                </p>
              )}
              <p className="text-text-secondary mt-4 text-sm">
                Foreground children appear in their delegation tool row. Completion is not
                acceptance.
              </p>
            </div>
            <div className="min-w-0 p-4 text-base" aria-live="polite">
              {!target ? (
                <p className="text-text-secondary">
                  Select a run or child to read its task, recent messages and result. This does not
                  open a second writer.
                </p>
              ) : (
                <>
                  <div className="mb-3 flex items-center justify-between gap-2">
                    <h3 className="font-medium">{inspection?.label ?? 'Child inspection'}</h3>
                    <Button size="sm" onClick={() => setRefresh((n) => n + 1)}>
                      Refresh
                    </Button>
                  </div>
                  <p className="text-text-secondary mb-3 break-all font-mono text-sm">
                    Run {target.runId}
                    {target.childId ? ` · child ${target.childId}` : ''}
                  </p>
                  {error ? (
                    <p role="alert" className="text-danger">
                      {error}
                    </p>
                  ) : !inspection ? (
                    <p>Reading child…</p>
                  ) : (
                    <>
                      <p className="text-text-secondary mb-3">
                        Run state at last read: {inspection.status ?? 'unavailable'}.{' '}
                        {target.childId &&
                          'This can describe the containing run, not the selected step. '}
                        Refresh to check again.
                      </p>
                      {inspection.task && (
                        <details className="mb-3">
                          <summary className="cursor-pointer font-medium">Delegated task</summary>
                          <Markdown text={inspection.task} />
                        </details>
                      )}
                      {inspection.messages.map((message, i) => (
                        <div key={i} className="border-border mb-3 border-l pl-3">
                          <span className="text-text-secondary font-mono text-xs uppercase">
                            {message.role}
                          </span>
                          <pre className="whitespace-pre-wrap break-words font-mono text-sm">
                            {message.text}
                          </pre>
                        </div>
                      ))}
                      {inspection.finalOutput && <Markdown text={inspection.finalOutput} />}
                      {inspection.truncated && (
                        <p className="text-text-secondary mt-3">
                          Bounded preview: some content was omitted.
                        </p>
                      )}
                      {!target.childId && fleet?.runs.some((run) => run.id === target.runId) && (
                        <SubagentStop
                          key={target.runId}
                          sessionId={sessionId}
                          runId={target.runId}
                        />
                      )}
                      {!inspection.messages.length && !inspection.finalOutput && (
                        <p className="text-text-secondary">No output in this preview.</p>
                      )}
                    </>
                  )}
                </>
              )}
            </div>
          </div>
        </ModalPanel>
      </section>
    </ModalOverlay>
  )
}
