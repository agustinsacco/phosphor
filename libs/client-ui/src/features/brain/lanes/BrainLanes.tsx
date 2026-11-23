import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/form'
import { useBrain } from '../useBrain'
import { useBrainResource } from '../useBrainResource'
import { useBrainHistory } from '../BrainHistory'
import { useTidyActions } from '../tidy/useTidyActions'
import type { BrainHistory, BrainJob, BrainPrefs } from '@shared/brain'
import type { BrainTidyOperation } from '@shared/brain-tidy'
import { LaneList } from './LaneList'
import { JobDetail } from './JobDetail'
import { ReadDetail } from './ReadDetail'
import { ChangeDetail } from './ChangeDetail'
import { NeverReadDetail, NeverReadRow } from './NeverRead'
import {
  finishedRead,
  jobsAhead,
  keepLaneSelection,
  laneGroups,
  laneKey,
  type LaneRow,
  type LaneSelection,
} from './laneGroups'

/** Where knowledge came from: reads by state, then the Tidy changes that can be undone. */
export function BrainLanes({
  selected,
  onSelect,
  onMemory,
}: {
  selected: LaneSelection | null
  onSelect: (selection: LaneSelection | null) => void
  onMemory: (id: string, label: string) => void
}): React.JSX.Element {
  const jobs = useBrain((s) => s.status!.jobs)
  const never = useBrain((s) => s.status!.prefs.neverRead)
  const { history, data, error, retry } = useBrainHistory()
  const changes = useTidyChanges()
  const now = useLaneClock(jobs.some((job) => TIMED.includes(job.state)))
  const groups = laneGroups(jobs, history)
  const operations = changes.data?.items ?? []
  const current = useLaneSelection(selected, onSelect, groups, operations, !!data && !!changes.data)
  const actions = useTidyActions(changes.retry)
  const undo = (id: string): void => actions.undo(id, changes.data?.revision ?? 0)
  const { row, unlisted, change } = selectedDetail(current, groups, operations, !!data)
  return (
    <div className="brain-panes brain-lanes">
      <section aria-label="Brain lanes" className="brain-pane brain-pane--side brain-pane--start">
        <div className="brain-scroll">
          <ReadsState
            error={error || changes.error}
            onRetry={error ? retry : changes.retry}
            loading={!history && !error}
          />
          <LaneList
            groups={groups}
            jobs={jobs}
            changes={operations}
            selected={current}
            onSelect={onSelect}
            onUndo={undo}
            busy={actions.busy}
            now={now}
            extra={
              <>
                <ReadsFooter history={history} empty={!groups.length && !operations.length} />
                <NeverReadRow
                  never={never}
                  selected={current?.type === 'never'}
                  onSelect={() => onSelect({ type: 'never' })}
                />
              </>
            }
          />
        </div>
      </section>
      <section aria-label="Lane detail" className="brain-pane brain-scroll">
        <LaneDetail
          history={history}
          never={current?.type === 'never' ? never : null}
          row={row}
          unlisted={unlisted}
          change={change}
          jobs={jobs}
          now={now}
          loaded={!!history}
          busy={actions.busy}
          message={actions.message}
          onUndo={undo}
          onMemory={onMemory}
          onRead={(id) => onSelect({ type: 'job', id })}
        />
      </section>
    </div>
  )
}

/** What the selection opens: a listed row, a read asked for by id, or a change. */
function selectedDetail(
  current: LaneSelection | null,
  groups: ReturnType<typeof laneGroups>,
  operations: BrainTidyOperation[],
  loaded: boolean,
): { row?: LaneRow; unlisted: string | null; change?: BrainTidyOperation } {
  const row = groups
    .flatMap((group) => group.rows)
    .find((entry) => current?.type === 'job' && entry.job.id === current.id)
  // A finished read asked for by id that the newest 200 do not include.
  const unlisted = current?.type === 'job' && !row && loaded ? current.id : null
  const change = operations.find((op) => current?.type === 'change' && op.id === current.id)
  return { row, unlisted, change }
}

/** Under the reads, before Never read: what to do when nothing is read, or that more exist. */
function ReadsFooter({
  history,
  empty,
}: {
  history: BrainHistory | null
  empty: boolean
}): React.JSX.Element {
  return (
    <>
      {history && empty && (
        <p className="text-text-tertiary p-3 text-sm">
          Nothing read yet. Right-click a lane and choose Queue for knowledge extraction.
        </p>
      )}
      {history?.more && (
        <p className="text-text-tertiary p-3 text-sm">Showing the newest 200 reads.</p>
      )}
    </>
  )
}

function ReadsState({
  error,
  onRetry,
  loading,
}: {
  error: string
  onRetry: () => void
  loading: boolean
}): React.JSX.Element | null {
  if (error)
    return (
      <p role="status" className="p-3 text-sm">
        {error}{' '}
        <Button size="xs" onClick={onRetry}>
          Retry
        </Button>
      </p>
    )
  return loading ? (
    <p role="status" className="text-text-tertiary p-3 text-sm">
      Loading reads…
    </p>
  ) : null
}

/** A read in progress, a finished read, a Tidy change, or the lanes Brain never reads. */
function LaneDetail({
  history,
  never,
  row,
  unlisted,
  change,
  jobs,
  now,
  loaded,
  busy,
  message,
  onUndo,
  onMemory,
  onRead,
}: {
  history: BrainHistory | null
  never: BrainPrefs['neverRead'] | null
  row: LaneRow | undefined
  unlisted: string | null
  change: BrainTidyOperation | undefined
  jobs: BrainJob[]
  now: number
  loaded: boolean
  busy: boolean
  message: string
  onUndo: (operationId: string) => void
  onMemory: (id: string, label: string) => void
  onRead: (id: string) => void
}): React.JSX.Element {
  if (never) return <NeverReadDetail never={never} />
  if (row && !finishedRead(row.job) && !['review', 'refreshing'].includes(row.job.state))
    return (
      <JobDetail
        key={row.job.id}
        job={row.job}
        now={now}
        ahead={jobsAhead(jobs, row.job.id)}
        onMemory={onMemory}
      />
    )
  const read = row?.job.id ?? unlisted
  if (read)
    return (
      <ReadDetail key={read} jobId={read} history={history} job={row?.job} onMemory={onMemory} />
    )
  if (change)
    return (
      <ChangeDetail change={change} onRead={onRead} busy={busy} message={message} onUndo={onUndo} />
    )
  return (
    <p className="text-text-tertiary p-6">{loaded ? 'Choose a read or a change.' : 'Loading…'}</p>
  )
}

/**
 * The selection in force, once fresh reads and changes have loaded: a finished job must not
 * look gone just because the list is reloading. Waiting reads stay in Lanes until Defrag decides them.
 */
function useLaneSelection(
  selected: LaneSelection | null,
  onSelect: (selection: LaneSelection | null) => void,
  groups: ReturnType<typeof laneGroups>,
  operations: BrainTidyOperation[],
  fresh: boolean,
): LaneSelection | null {
  const jobs = useBrain((s) => s.status!.jobs)
  const listed = useListedJobs(groups)
  const reviews = jobs.filter((job) => job.state === 'review').map((job) => job.id)
  const current = fresh
    ? keepLaneSelection(selected, groups, operations, new Set([...listed, ...reviews]))
    : selected
  useEffect(() => {
    if (laneKey(current) !== laneKey(selected)) onSelect(current)
  }, [current, selected, onSelect])
  return current
}

/** Every job id the list has shown while mounted. */
function useListedJobs(groups: ReturnType<typeof laneGroups>): ReadonlySet<string> {
  const seen = useRef(new Set<string>())
  for (const group of groups) for (const row of group.rows) seen.current.add(row.job.id)
  return seen.current
}

/** Recent Tidy changes, reloaded when Tidy or Brain changes; rows stay while reloading. */
function useTidyChanges() {
  const summary = useBrain((s) => JSON.stringify([s.status?.agent, s.status?.tidy]))
  const resource = useBrainResource(
    useCallback(() => window.phosphor.invoke('brain:tidyChanges', 50), []),
    true,
    summary,
  )
  const [previous, setPrevious] = useState(resource.data)
  useEffect(() => {
    if (resource.data) setPrevious(resource.data)
  }, [resource.data])
  return { ...resource, data: resource.data ?? previous }
}

/** States whose row shows a time that moves: how long it has read, or how long it waited. */
const TIMED: readonly BrainJob['state'][] = ['running', 'refreshing', 'queued', 'waiting', 'review']

/** Times are in minutes, so a coarse tick is enough while anything is reading or queued. */
function useLaneClock(active: boolean): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => setNow(Date.now()), 15_000)
    return () => clearInterval(timer)
  }, [active])
  return now
}
