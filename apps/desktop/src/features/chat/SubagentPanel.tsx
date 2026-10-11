import { useEffect, useRef, useState } from 'react'
import { ModalOverlay, ModalPanel } from '@/components/Modal'
import { Button } from '@/components/form'
import { Markdown } from '@/components/markdown/Markdown'
import { useExtensionUiStore } from '@/stores/extensionUi'
import { errorText } from '@shared/errors'
import { parseFleetWidget, SUBAGENT_ASYNC_WIDGET_KEY, type FleetNode } from './subagentRuns'
import { useChatStore } from '@/stores/chat'
import { useLayoutStore } from '@/stores/layout'
import { useSubagentInspection } from './useSubagentInspection'
import {
  loadSubagentView,
  saveSubagentView,
  selectedFleetNode,
  type SubagentTarget,
} from './subagentView'
import { subagentHistory } from './subagentHistory'
import { isFleetActive } from './subagentRuns'
import { SubagentActions } from './SubagentActions'
import { SubagentActivity } from './SubagentActivity'
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
  const identity = useChatStore((s) => s.sessions[sessionId]?.meta?.sessionId)
  const diskPath = useChatStore((s) => s.sessions[sessionId]?.meta?.sessionFile)
  const [view, setView] = useState<'live' | 'history'>('live')
  const [target, setTarget] = useState<SubagentTarget>()
  const [restored, setRestored] = useState<string>()
  const [restoreError, setRestoreError] = useState<string>()
  const selectionRevision = useRef(0)
  const select = (next: SubagentTarget): void => {
    selectionRevision.current++
    setRestoreError(undefined)
    setTarget(next)
  }
  useEffect(() => {
    let cancelled = false
    const revision = ++selectionRevision.current
    setTarget(undefined)
    setRestored(undefined)
    setRestoreError(undefined)
    const saved = identity ? loadSubagentView(identity) : { view: 'live' as const }
    setView(initialRunId ? 'live' : saved.view)
    const wanted = initialRunId ? { runId: initialRunId } : saved.target
    void (async () => {
      try {
        if (wanted) {
          const reply = await window.phosphor.piCommand(sessionId, { type: 'get_entries' })
          if (!reply.success || !reply.data)
            throw new Error('Cannot validate the saved selection on this branch.')
          const history = subagentHistory(reply.data.entries, reply.data.leafId)
          const current = parseFleetWidget(
            useExtensionUiStore.getState().widgets[sessionId]?.[SUBAGENT_ASYNC_WIDGET_KEY]?.lines,
          )
          if (!history.runIds.has(wanted.runId) && !selectedFleetNode(current, wanted))
            throw new Error(
              'The saved selection is not available on this branch. Choose a run again.',
            )
          if (!cancelled && revision === selectionRevision.current) setTarget(wanted)
        }
      } catch (error) {
        if (!cancelled && revision === selectionRevision.current) setRestoreError(errorText(error))
      } finally {
        if (!cancelled) setRestored(identity)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [sessionId, identity, diskPath, initialRunId])
  useEffect(() => {
    if (identity && restored === identity) saveSubagentView(identity, { view, target })
  }, [identity, restored, view, target])
  const selected = selectedFleetNode(fleet, target)
  const active = !!selected && isFleetActive(selected.state)
  const { inspection, readAt, error, loading, refresh } = useSubagentInspection(
    sessionId,
    target,
    view === 'live',
    active,
  )

  const node = (entry: FleetNode, root: string, depth = 0): React.JSX.Element => (
    <li key={entry.id}>
      <button
        className="hover:bg-bg-secondary aria-pressed:bg-bg-secondary text-text flex w-full flex-wrap items-center gap-x-2 rounded-md px-2 py-2 text-left text-base"
        aria-pressed={target?.runId === root && target.childId === (depth ? entry.id : undefined)}
        onClick={() => select({ runId: root, ...(depth ? { childId: entry.id } : {}) })}
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
      <div className="px-2">
        <SubagentActivity node={entry} />
      </div>
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
          {restoreError && (
            <p role="status" className="text-text-secondary px-4 py-2">
              {restoreError}
            </p>
          )}
          {view === 'history' && (
            <SubagentJournal
              sessionId={sessionId}
              onInspect={(runId) => {
                select({ runId })
                setView('live')
              }}
            />
          )}
          {view === 'live' && (
            <div className="grid max-h-[70vh] min-h-48 overflow-auto md:grid-cols-[16rem_minmax(0,1fr)]">
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
                    Select a run or child to read its task, recent messages and result. This does
                    not open a second writer.
                  </p>
                ) : (
                  <>
                    <div className="mb-3 flex items-center justify-between gap-2">
                      <h3 className="font-medium">{inspection?.label ?? 'Child inspection'}</h3>
                      <Button size="sm" disabled={loading} onClick={refresh}>
                        Refresh
                      </Button>
                    </div>
                    <p className="text-text-secondary mb-3 break-all font-mono text-sm">
                      Run {target.runId}
                      {target.childId ? ` · child ${target.childId}` : ''}
                    </p>
                    {error && (
                      <div>
                        <p role="alert" className="text-danger">
                          {error}
                          {inspection && ' Any preview below is from the last successful read.'}
                        </p>
                        <Button
                          size="sm"
                          onClick={() => {
                            useLayoutStore.getState().setRightPane('artifacts', sessionId)
                            onClose()
                          }}
                        >
                          Open Artifacts
                        </Button>
                      </div>
                    )}
                    {!inspection ? (
                      <p>
                        {loading
                          ? 'Reading child…'
                          : 'Inspection unavailable. Any saved snapshots remain in Artifacts.'}
                      </p>
                    ) : (
                      <>
                        <p className="text-text-secondary mb-3">
                          Run state at last read: {inspection.status ?? 'unavailable'}.{' '}
                          {target.childId &&
                            'This can describe the containing run, not the selected step. '}
                          {error
                            ? 'Automatic retries back off and pause after three failures. Refresh to retry.'
                            : active
                              ? 'Refreshes every 5 seconds while this view and window are active.'
                              : 'Refresh to check again.'}
                        </p>
                        {readAt && (
                          <p className="text-text-secondary mb-3 text-sm">
                            Read at {new Date(readAt).toLocaleTimeString()}.
                          </p>
                        )}
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
                        {readAt && (
                          <SubagentActions
                            key={`${identity}:${target.runId}:${target.childId}`}
                            sessionId={sessionId}
                            target={target}
                            inspection={inspection}
                            readAt={readAt}
                            active={active}
                            onClose={onClose}
                          />
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
          )}
        </ModalPanel>
      </section>
    </ModalOverlay>
  )
}
