import { useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import { PaneShell, PaneTitle } from '@/components/PaneShell'
import { Button } from '@/components/form'
import { useExtensionUiStore } from '@/stores/extensionUi'
import { errorText } from '@shared/errors'
import { parseFleetWidget, SUBAGENT_ASYNC_WIDGET_KEY, isFleetActive } from './subagentRuns'
import { useChatStore } from '@/stores/chat'
import { useLayoutStore } from '@/stores/layout'
import { useSubagentInspection } from './useSubagentInspection'
import {
  loadSubagentView,
  saveSubagentView,
  selectedFleetNode,
  useSubagentNavigation,
  type SubagentTarget,
} from './subagentView'
import { subagentHistory } from './subagentHistory'
import { SubagentActions } from './SubagentActions'
import { SubagentJournal } from './SubagentJournal'
import { SubagentStop } from './SubagentStopControl'
import { SubagentTree } from './SubagentTree'
import { SubagentPreview } from './SubagentPreview'

export function SubagentPanel({ sessionId }: { sessionId: string }): React.JSX.Element {
  const lines = useExtensionUiStore((s) => s.widgets[sessionId]?.[SUBAGENT_ASYNC_WIDGET_KEY]?.lines)
  const fleet = parseFleetWidget(lines)
  const identity = useChatStore((s) => s.sessions[sessionId]?.meta?.sessionId)
  const diskPath = useChatStore((s) => s.sessions[sessionId]?.meta?.sessionFile)
  const revision = useSubagentNavigation((s) => (s.sessionId === sessionId ? s.revision : 0))
  const covered = useLayoutStore((s) => s.page !== null)
  const [view, setView] = useState<'live' | 'history'>('live')
  const [target, setTarget] = useState<SubagentTarget>()
  const [showList, setShowList] = useState(true)
  const [narrow, setNarrow] = useState(false)
  const pane = useRef<HTMLElement>(null)
  useEffect(() => {
    if (!pane.current || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setNarrow(entry.contentRect.width < 640)
    })
    observer.observe(pane.current)
    return () => observer.disconnect()
  }, [])
  const [restored, setRestored] = useState<string>()
  const [restoreError, setRestoreError] = useState<string>()
  const detailTitle = useRef<HTMLHeadingElement>(null)
  const navigation = useRef<HTMLElement>(null)
  const focusDetail = useRef(false)
  const selectionRevision = useRef(0)
  const select = (next: SubagentTarget): void => {
    selectionRevision.current++
    setRestoreError(undefined)
    setTarget(next)
    setShowList(false)
    focusDetail.current = true
  }
  useEffect(() => {
    if (focusDetail.current) {
      detailTitle.current?.focus()
      focusDetail.current = false
    }
  }, [target])
  useEffect(() => {
    let cancelled = false
    const selection = ++selectionRevision.current
    setTarget(undefined)
    setRestored(undefined)
    setRestoreError(undefined)
    const request = useSubagentNavigation.getState()
    if (identity && request.sessionId === sessionId && request.runId) {
      saveSubagentView(identity, { view: 'live', target: { runId: request.runId } })
      useSubagentNavigation.setState({ runId: undefined })
    }
    const saved = identity ? loadSubagentView(identity) : { view: 'live' as const }
    setView(saved.view)
    const wanted = saved.target
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
          if (!cancelled && selection === selectionRevision.current) {
            setTarget(wanted)
            setShowList(false)
          }
        }
      } catch (error) {
        if (!cancelled && selection === selectionRevision.current) setRestoreError(errorText(error))
      } finally {
        if (!cancelled) setRestored(identity)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [sessionId, identity, diskPath, revision])
  useEffect(() => {
    if (identity && restored === identity) saveSubagentView(identity, { view, target })
  }, [identity, restored, view, target])
  const selected = selectedFleetNode(fleet, target)
  const active = !!selected && isFleetActive(selected.state)
  const { inspection, readAt, error, loading, refresh } = useSubagentInspection(
    sessionId,
    target,
    view === 'live' && !covered && !(narrow && showList),
    active,
  )

  return (
    <section
      ref={pane}
      aria-label="Subagents"
      className="@container flex h-full min-h-0 min-w-0 flex-col"
    >
      <PaneShell title={<PaneTitle label="Subagents" />}>
        <div
          className="border-border flex shrink-0 gap-2 border-b px-3 py-2"
          aria-label="Subagent views"
        >
          <Button size="sm" aria-pressed={view === 'live'} onClick={() => setView('live')}>
            Live work
          </Button>
          <Button size="sm" aria-pressed={view === 'history'} onClick={() => setView('history')}>
            Recorded coordination
          </Button>
        </div>
        {restoreError && (
          <p role="status" className="text-text-secondary px-3 py-2 text-base">
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
        <div
          className={clsx(
            'min-h-0 flex-1 overflow-hidden @min-[640px]:grid-cols-[15rem_minmax(0,1fr)]',
            view === 'live' ? 'grid' : 'hidden',
          )}
        >
          <nav
            ref={navigation}
            aria-label="Background runs"
            className={clsx(
              'border-border min-h-0 overflow-y-auto overscroll-contain border-r p-2 @min-[640px]:block',
              !showList && target && 'hidden',
            )}
          >
            <h3 className="text-text-secondary mb-2 px-2 text-sm font-medium">Background runs</h3>
            {fleet?.runs.length ? (
              <SubagentTree nodes={fleet.runs} target={target} onSelect={select} />
            ) : (
              <p className="text-text-secondary p-2 text-base">
                No live snapshot. Recorded results remain in the conversation.
              </p>
            )}
            {fleet?.incomplete && (
              <p className="text-text-secondary p-2 text-sm">
                Snapshot incomplete; some work may not be shown.
              </p>
            )}
            <p className="text-text-secondary mt-3 px-2 text-sm">
              Foreground children appear in their delegation tool row. Completion is not acceptance.
            </p>
          </nav>
          <div
            className={clsx(
              'min-h-0 min-w-0 flex-col @min-[640px]:flex',
              showList || !target ? 'hidden' : 'flex',
            )}
          >
            {!target ? (
              <p className="text-text-secondary p-4 text-base">
                Select a run or child to read its task, recent messages and result.
              </p>
            ) : (
              <>
                <div className="border-border shrink-0 border-b px-3 py-2 text-base">
                  <button
                    className="text-text-secondary mb-2 rounded underline @min-[640px]:hidden"
                    onClick={() => {
                      setShowList(true)
                      requestAnimationFrame(() =>
                        navigation.current
                          ?.querySelector<HTMLButtonElement>('[aria-pressed="true"]')
                          ?.focus(),
                      )
                    }}
                  >
                    Back to runs
                  </button>
                  <div className="flex items-start justify-between gap-2">
                    <h3
                      ref={detailTitle}
                      tabIndex={-1}
                      className="min-w-0 line-clamp-2 break-words font-semibold"
                    >
                      {selected?.label ?? inspection?.label ?? 'Child inspection'}
                    </h3>
                    <Button size="sm" disabled={loading} onClick={refresh}>
                      Refresh
                    </Button>
                  </div>
                  <p className="text-text-secondary mt-1 text-sm" role="status">
                    {selected ? selected.state : 'Last known'}
                    {readAt
                      ? ` · Read at ${new Date(readAt).toLocaleTimeString()}`
                      : loading
                        ? ' · Reading child…'
                        : ''}
                  </p>
                  <details className="mt-2" key={`${target.runId}:${target.childId}`}>
                    <summary className="text-text-secondary cursor-pointer text-sm">
                      Details & actions
                    </summary>
                    <div className="max-h-64 space-y-2 overflow-auto py-2">
                      <p className="break-all font-mono text-sm">
                        Run {target.runId}
                        {target.childId ? ` · child ${target.childId}` : ''}
                      </p>
                      <p className="text-text-secondary text-sm">
                        Run state at last read: {inspection?.status ?? 'unavailable'}.{' '}
                        {target.childId &&
                          'This can describe the containing run, not the selected step. '}
                        Read-only inspection; Pi owns execution.{' '}
                        {active
                          ? 'Refreshes every 5 seconds while visible and focused.'
                          : 'Refresh to check again.'}
                      </p>
                      {inspection && readAt && (
                        <SubagentActions
                          sessionId={sessionId}
                          target={target}
                          inspection={inspection}
                          readAt={readAt}
                          active={active}
                        />
                      )}
                      {!target.childId && fleet?.runs.some((run) => run.id === target.runId) && (
                        <SubagentStop sessionId={sessionId} runId={target.runId} />
                      )}
                    </div>
                  </details>
                </div>
                {error && (
                  <div className="border-border shrink-0 border-b p-3 text-base">
                    <p role="alert" className="text-danger">
                      {error}
                      {inspection && ' Any preview below is from the last successful read.'}
                    </p>
                    <p className="text-text-secondary text-sm">
                      Automatic retries back off and pause after three failures. Refresh to retry.
                    </p>
                    <Button
                      size="sm"
                      onClick={() => useLayoutStore.getState().setRightPane('artifacts', sessionId)}
                    >
                      Open Artifacts
                    </Button>
                  </div>
                )}
                {inspection ? (
                  <SubagentPreview
                    key={`${target.runId}:${target.childId}`}
                    inspection={inspection}
                  />
                ) : (
                  <p className="text-text-secondary p-4 text-base">
                    {loading
                      ? 'Reading child…'
                      : 'Inspection unavailable. Any saved snapshots remain in Artifacts.'}
                  </p>
                )}
              </>
            )}
          </div>
        </div>
      </PaneShell>
    </section>
  )
}
