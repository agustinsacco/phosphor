import { TooltipButton, TooltipSummary } from '@/components/Tooltip'
import { useEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import { PaneShell, PaneTitle } from '@/components/PaneShell'
import { RefreshIcon } from '@/components/icons'
import { Button } from '@/components/form'
import { useExtensionUiStore } from '@/stores/extensionUi'
import { errorText } from '@shared/errors'
import { parseFleetWidget, SUBAGENT_ASYNC_WIDGET_KEY, isFleetActive, shortId } from './subagentRuns'
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
import { SubagentPreview } from './SubagentPreview'
import { useCurrentWork, type WorkEntry } from './currentWork'
import { SubagentDetail } from './tools/SubagentDetail'
import { SubagentStateDot, SubagentWorkRow, WORK_SECTION_CLASS } from './SubagentWorkRow'
import {
  activityText,
  elapsed,
  newestWork,
  stateWord,
  supervisorHandoff,
} from './subagentPresentation'
import { useNow } from './useNow'

export function SubagentPanel({ sessionId }: { sessionId: string }): React.JSX.Element {
  const lines = useExtensionUiStore((s) => s.widgets[sessionId]?.[SUBAGENT_ASYNC_WIDGET_KEY]?.lines)
  // Up to 128 KB, and the pane re-renders every second while work runs.
  const fleet = useMemo(() => parseFleetWidget(lines), [lines])
  const work = useCurrentWork(sessionId)
  const [foregroundId, setForegroundId] = useState<string>()
  const foreground = foregroundId ? work.tools[foregroundId] : undefined
  const identity = useChatStore((s) => s.sessions[sessionId]?.meta?.sessionId)
  const diskPath = useChatStore((s) => s.sessions[sessionId]?.meta?.sessionFile)
  const revision = useSubagentNavigation((s) => (s.sessionId === sessionId ? s.revision : 0))
  const covered = useLayoutStore((s) => s.page !== null)
  const [view, setView] = useState<'live' | 'history'>('live')
  const [target, setTarget] = useState<SubagentTarget>()
  const hasSelection = !!target || !!foregroundId
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
    setForegroundId(undefined)
    setTarget(next)
    setShowList(false)
    focusDetail.current = true
  }
  useEffect(() => {
    if (focusDetail.current) {
      detailTitle.current?.focus()
      focusDetail.current = false
    }
  }, [target, foregroundId])
  useEffect(() => {
    let cancelled = false
    const selection = ++selectionRevision.current
    setTarget(undefined)
    setRestored(undefined)
    setRestoreError(undefined)
    const request = useSubagentNavigation.getState()
    setForegroundId(undefined)
    if (request.sessionId === sessionId && request.toolCallId) {
      setForegroundId(request.toolCallId)
      setTarget(undefined)
      setView('live')
      setShowList(false)
      focusDetail.current = true
      useSubagentNavigation.setState({ toolCallId: undefined })
      return
    }
    if (identity && request.sessionId === sessionId && request.runId) {
      saveSubagentView(identity, {
        view: 'live',
        target: { runId: request.runId, childId: request.childId },
      })
      useSubagentNavigation.setState({ runId: undefined, childId: undefined })
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
  // An "Inspect run" link names the run. A single-agent run's activity lives
  // in its one step, so the same agent is selected either way, including when
  // only its launch remains (after a restart) and the saved target is the step.
  const selectedEntry = target
    ? work.entries.find(
        (e) =>
          e.runId === target.runId &&
          (e.childId === target.childId ||
            (e.single && (!target.childId || (!e.childId && target.childId === 'step:0')))),
      )
    : undefined
  const resolved: SubagentTarget | undefined =
    target && selectedEntry?.single && selectedEntry.childId
      ? { runId: target.runId, childId: selectedEntry.childId }
      : target
  const selected = selectedFleetNode(fleet, resolved)
  const handoff = resolved
    ? supervisorHandoff(work.tools, work.items, resolved, { single: !!selectedEntry?.single })
    : undefined
  const active = (!!selected && isFleetActive(selected.state)) || !!selectedEntry?.active
  const now = useNow(work.entries.some((entry) => entry.active > 0))
  const { inspection, readAt, error, loading, refresh } = useSubagentInspection(
    sessionId,
    resolved,
    view === 'live' && !foregroundId && !covered && !(narrow && showList),
    active,
  )
  const foregroundEntry = work.entries.find((e) => !e.runId && e.toolCallId === foregroundId)
  const ordered = newestWork(work.entries)
  const keptForeground = new Set(
    ordered
      .filter((e) => !e.runId && e.toolCallId)
      .filter((e, index) => e.active || e.toolCallId === foregroundId || index < 20)
      .map((e) => e.id),
  )
  const visible = ordered.filter((e) => e.runId || keptForeground.has(e.id))
  const items = navItems(visible, work.entries)
  const working = items.filter((item) => itemEntries(item).some(isCurrent))
  const earlier = items.filter((item) => !working.includes(item))
  const openEntry = (entry: WorkEntry): void => {
    if (entry.runId) {
      select({ runId: entry.runId, childId: entry.childId })
      return
    }
    selectionRevision.current++
    setRestoreError(undefined)
    setTarget(undefined)
    setForegroundId(entry.toolCallId)
    setShowList(false)
    focusDetail.current = true
  }
  const row = (entry: WorkEntry, grouped = false): React.JSX.Element => (
    <SubagentWorkRow
      key={entry.id}
      entry={entry}
      now={now}
      grouped={grouped}
      selected={
        entry.runId ? !foregroundId && entry === selectedEntry : foregroundId === entry.toolCallId
      }
      onClick={() => openEntry(entry)}
    />
  )
  const renderItems = (list: NavItem[]): React.JSX.Element[] =>
    list.map((item) =>
      'entry' in item ? (
        row(item.entry)
      ) : (
        <div key={item.group.id} className="min-w-0">
          <TooltipButton
            type="button"
            aria-label={`${item.group.label} run`}
            aria-pressed={!foregroundId && resolved?.runId === item.group.id && !resolved?.childId}
            onClick={() => select({ runId: item.group.id })}
            className="text-text-secondary hover:text-text aria-pressed:bg-accent-soft block w-full truncate rounded px-2 py-1 text-left text-xs"
          >
            {item.group.label} · #{shortId(item.group.id)}
          </TooltipButton>
          {/* The run's own entry is its header, not a row of its own. */}
          <div className="border-border ml-3 border-l pl-1">
            {item.entries.filter((entry) => entry.childId).map((entry) => row(entry, true))}
          </div>
        </div>
      ),
    )
  const header = (entry: WorkEntry | undefined, fallback: string): React.JSX.Element => (
    <>
      <h3
        ref={detailTitle}
        tabIndex={-1}
        className="focus-target min-w-0 line-clamp-2 break-words text-lg font-semibold"
      >
        {entry?.title ?? fallback}
      </h3>
      <p className="text-text-secondary mt-1 flex min-w-0 items-center gap-1.5 text-sm">
        {entry && <SubagentStateDot entry={entry} />}
        <span className="min-w-0 truncate">
          {[
            // State first: on a narrow pane the rest truncates, never this.
            <span key="state" role="status">
              {stateWord(entry?.state ?? selected?.state ?? 'status unavailable')}
            </span>,
            entry?.title !== undefined && entry.title !== entry.label && entry.label,
            // Running time, or a measured duration; never time since a start
            // for work with no reported end.
            entry?.startedAt !== undefined &&
              (entry.active
                ? elapsed(now - entry.startedAt)
                : entry.endedAt !== undefined && elapsed(entry.endedAt - entry.startedAt)),
            entry?.toolCount !== undefined &&
              `${entry.toolCount} ${entry.toolCount === 1 ? 'tool' : 'tools'}`,
            entry?.turnCount !== undefined &&
              `${entry.turnCount} ${entry.turnCount === 1 ? 'turn' : 'turns'}`,
            entry?.runId && `#${shortId(entry.runId)}`,
          ]
            .filter(Boolean)
            .flatMap((part, i) => (i ? [' · ', part] : [part]))}
        </span>
      </p>
    </>
  )

  return (
    <section
      ref={pane}
      aria-label="Subagents"
      className="@container flex h-full min-h-0 min-w-0 flex-col"
    >
      <PaneShell title={<PaneTitle label="Subagents" />}>
        <div
          role="group"
          className="border-border flex shrink-0 gap-2 border-b px-3 py-2"
          aria-label="Subagent views"
        >
          <Button
            size="sm"
            className="text-text-secondary aria-pressed:bg-bg-secondary aria-pressed:text-text"
            aria-pressed={view === 'live'}
            onClick={() => setView('live')}
          >
            Agents
          </Button>
          <Button
            size="sm"
            className="text-text-secondary aria-pressed:bg-bg-secondary aria-pressed:text-text"
            aria-pressed={view === 'history'}
            onClick={() => setView('history')}
          >
            Coordination log
          </Button>
        </div>
        {restoreError && (
          <p role="status" className="text-text-secondary px-3 py-2 text-sm">
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
            'min-h-0 flex-1 overflow-hidden @min-[640px]:grid-cols-[17rem_minmax(0,1fr)]',
            view === 'live' ? 'grid' : 'hidden',
          )}
        >
          <nav
            ref={navigation}
            aria-label="Agent runs"
            className={clsx(
              'border-border min-h-0 overflow-y-auto overscroll-contain border-r p-1.5 @min-[640px]:block',
              !showList && hasSelection && 'hidden',
            )}
          >
            {working.length > 0 && <h3 className={WORK_SECTION_CLASS}>Working</h3>}
            {renderItems(working)}
            {earlier.length > 0 && <h3 className={WORK_SECTION_CLASS}>Earlier</h3>}
            {renderItems(earlier)}
            {!items.length && (
              <p className="text-text-secondary p-2 text-sm">No agents in this conversation yet.</p>
            )}
            {fleet?.incomplete && (
              <p className="text-text-secondary p-2 text-sm">
                Some work was left out of the snapshot.
              </p>
            )}
          </nav>
          <div
            className={clsx(
              'min-h-0 min-w-0 flex-col @min-[640px]:flex',
              showList || !hasSelection ? 'hidden' : 'flex',
            )}
          >
            {foregroundId ? (
              <>
                <div className="border-border shrink-0 border-b px-3 py-2">
                  <TooltipButton
                    className="text-text-secondary mb-2 text-xs underline @min-[640px]:hidden"
                    onClick={() => setShowList(true)}
                  >
                    Back to runs
                  </TooltipButton>
                  {header(foregroundEntry, 'Foreground delegation')}
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
                  {foreground ? (
                    <SubagentDetail key={foregroundId} tool={foreground} />
                  ) : (
                    <p className="text-text-secondary p-3 text-sm">
                      Delegation unavailable on this branch.
                    </p>
                  )}
                </div>
              </>
            ) : !resolved ? (
              <p className="text-text-secondary p-4 text-sm">
                Select an agent to see what it is doing, its task and its result.
              </p>
            ) : (
              <>
                <div className="border-border shrink-0 border-b px-3 py-2">
                  <TooltipButton
                    className="text-text-secondary mb-2 rounded text-xs underline @min-[640px]:hidden"
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
                  </TooltipButton>
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      {header(selectedEntry, selected?.label ?? inspection?.label ?? 'Agent')}
                    </div>
                    <TooltipButton
                      aria-label="Refresh"
                      tooltip="Read activity again"
                      disabled={loading}
                      onClick={refresh}
                      className="text-text-secondary hover:bg-bg-secondary hover:text-text flex size-6 shrink-0 items-center justify-center rounded disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-accent"
                    >
                      <RefreshIcon />
                    </TooltipButton>
                  </div>
                  <details className="mt-1" key={`${resolved.runId}:${resolved.childId}`}>
                    <TooltipSummary className="text-text-secondary cursor-pointer text-sm">
                      Details & actions
                    </TooltipSummary>
                    <div className="max-h-64 space-y-2 overflow-auto py-2">
                      <p className="break-all font-mono text-xs">
                        Run {resolved.runId}
                        {resolved.childId ? ` · child ${resolved.childId}` : ''}
                      </p>
                      <p className="text-text-secondary text-xs">
                        Run state at last read: {inspection?.status ?? 'unavailable'}
                        {readAt ? ` (${new Date(readAt).toLocaleTimeString()})` : ''}.{' '}
                        {resolved.childId &&
                          !selectedEntry?.single &&
                          'This can describe the containing run, not the selected step. '}
                        Read-only; Pi owns execution.{' '}
                        {active
                          ? 'Activity refreshes every 5 seconds while visible and focused.'
                          : 'Refresh to check again.'}
                      </p>
                      {inspection && readAt && (
                        <SubagentActions
                          sessionId={sessionId}
                          target={resolved}
                          inspection={inspection}
                          readAt={readAt}
                          active={active}
                        />
                      )}
                      {fleet?.runs.some((run) => run.id === resolved.runId) &&
                        (!resolved.childId || selectedEntry?.single) && (
                          <SubagentStop sessionId={sessionId} runId={resolved.runId} />
                        )}
                    </div>
                  </details>
                </div>
                {error && (
                  <div className="border-border shrink-0 border-b p-3 text-sm">
                    <p role="alert" className="text-danger">
                      {error}
                      {inspection && ' Any activity below is from the last successful read.'}
                    </p>
                    <p className="text-text-secondary text-xs">
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
                {!inspection && !loading && !error && (
                  <p className="text-text-secondary border-border shrink-0 border-b px-3 py-2 text-xs">
                    Activity unavailable. Any saved snapshots remain in Artifacts.
                  </p>
                )}
                <SubagentPreview
                  key={`${resolved.runId}:${resolved.childId}`}
                  inspection={inspection}
                  handoff={handoff}
                  live={active}
                  now={selectedEntry && active ? activityText(selectedEntry, now) : undefined}
                  loading={loading}
                />
              </>
            )}
          </div>
        </div>
      </PaneShell>
    </section>
  )
}

type NavItem = { entry: WorkEntry } | { group: { id: string; label: string }; entries: WorkEntry[] }
const isCurrent = (entry: WorkEntry): boolean =>
  entry.active > 0 || entry.state === 'status unavailable'
const itemEntries = (item: NavItem): WorkEntry[] => ('entry' in item ? [item.entry] : item.entries)

/**
 * Children of one workflow or parallel run stay together, at their newest
 * member's place, in the run's own order (`native` is the snapshot order).
 */
function navItems(entries: WorkEntry[], native: WorkEntry[]): NavItem[] {
  const groups = new Map<string, WorkEntry[]>()
  const items: NavItem[] = []
  for (const entry of entries) {
    if (!entry.group) {
      items.push({ entry })
      continue
    }
    let members = groups.get(entry.group.id)
    if (!members) {
      members = []
      groups.set(entry.group.id, members)
      items.push({ group: entry.group, entries: members })
    }
    members.push(entry)
  }
  for (const members of groups.values())
    members.sort((a, b) => native.indexOf(a) - native.indexOf(b))
  return items
}
