import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/form'
import { useBrain } from '../useBrain'
import { useBrainResource } from '../useBrainResource'
import { useBrainHistory } from '../BrainHistory'
import type { useTidyPage } from '../tidy/useTidyPage'
import { useTidyActions } from '../tidy/useTidyActions'
import { LaneList } from './LaneList'
import { JobDetail } from './JobDetail'
import { ReadDetail } from './ReadDetail'
import { ChangeDetail } from './ChangeDetail'
import { jobsAhead, keepLaneSelection, laneGroups, laneKey, type LaneSelection } from './laneGroups'

/** Where knowledge came from: reads by state, then the Tidy changes that can be undone. */
export function BrainLanes({
  tidy,
  selected,
  onSelect,
  onMemory,
}: {
  tidy: ReturnType<typeof useTidyPage>
  selected: LaneSelection | null
  onSelect: (selection: LaneSelection | null) => void
  onMemory: (id: string, label: string) => void
}): React.JSX.Element {
  const jobs = useBrain((s) => s.status!.jobs)
  const { history, data, error, retry } = useBrainHistory()
  const changes = useTidyChanges()
  const now = useLaneClock(jobs.some((job) => job.state !== 'review'))
  const groups = laneGroups(jobs, history)
  const operations = changes.data?.items ?? []
  // Wait for fresh reads before deciding a finished job has disappeared.
  const current = data && changes.data ? keepLaneSelection(selected, groups, operations) : selected
  useEffect(() => {
    if (laneKey(current) !== laneKey(selected)) onSelect(current)
  }, [current, selected, onSelect])
  const actions = useTidyActions({
    detail: null,
    page: tidy.page,
    reload: tidy.reload,
    onChanged: changes.retry,
  })
  const undo = (id: string): void => actions.undo(id, changes.data?.revision ?? 0)
  const row = groups
    .flatMap((group) => group.rows)
    .find((entry) => current?.type === 'job' && entry.job.id === current.id)
  const change = operations.find((op) => current?.type === 'change' && op.id === current.id)
  return (
    <div className="brain-panes brain-lanes">
      <section aria-label="Brain lanes" className="brain-pane brain-pane--side brain-pane--start">
        <div className="brain-scroll">
          {(error || changes.error) && (
            <p role="status" className="p-3 text-sm">
              {error || changes.error}{' '}
              <Button size="xs" onClick={error ? retry : changes.retry}>
                Retry
              </Button>
            </p>
          )}
          {!history && !error && (
            <p role="status" className="text-text-tertiary p-3 text-sm">
              Loading reads…
            </p>
          )}
          <LaneList
            groups={groups}
            jobs={jobs}
            changes={operations}
            selected={current}
            onSelect={onSelect}
            onUndo={undo}
            busy={actions.busy}
            now={now}
          />
          {history && !groups.length && !operations.length && (
            <p className="text-text-tertiary p-3 text-sm">
              Nothing read yet. Right-click a lane and choose Queue for knowledge extraction.
            </p>
          )}
          {history?.more && (
            <p className="text-text-tertiary p-3 text-sm">Showing the newest 200 reads.</p>
          )}
        </div>
      </section>
      <section aria-label="Lane detail" className="brain-pane brain-scroll">
        {row && (row.job.state === 'done' || row.job.state === 'empty') ? (
          <ReadDetail key={row.job.id} jobId={row.job.id} onMemory={onMemory} />
        ) : row ? (
          <JobDetail
            key={row.job.id}
            job={row.job}
            now={now}
            ahead={jobsAhead(jobs, row.job.id)}
            onMemory={onMemory}
          />
        ) : change ? (
          <ChangeDetail
            change={change}
            busy={actions.busy}
            message={actions.message}
            onUndo={undo}
          />
        ) : (
          <p className="text-text-tertiary p-6">
            {history ? 'Choose a read or a change.' : 'Loading…'}
          </p>
        )}
      </section>
    </div>
  )
}

/** Recent Tidy changes, reloaded when Tidy or Brain changes; rows stay while reloading. */
function useTidyChanges() {
  const summary = useBrain((s) => JSON.stringify(s.status?.tidy))
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
