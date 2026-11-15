import { useEffect, useState } from 'react'
import { ListDetail } from '@/components/ListDetail'
import { Button } from '@/components/form'
import { useBrain } from './useBrain'
import { useBrainHistory } from './BrainHistory'
import { BrainInbox } from './BrainInbox'
import { BrainLaneDetail } from './BrainLaneDetail'
import { groupBrainLanes, selectBrainLane } from './laneRows'
import './BrainLanes.css'

export function BrainLanes({
  selected,
  onSelect,
  readId,
  onMemory,
}: {
  selected: string | null
  onSelect: (id: string | null) => void
  readId: string | null
  onMemory: (id: string, label: string) => void
}): React.JSX.Element {
  const jobs = useBrain((s) => s.status!.jobs)
  const { history, data, error, retry } = useBrainHistory()
  const now = useReadingClock(jobs.some((job) => job.state === 'running'))
  const groups = groupBrainLanes(jobs, history)
  // Wait for fresh history before deciding a completed job has disappeared.
  const current =
    readId ??
    (data ? selectBrainLane(selected, groups) : (selected ?? selectBrainLane(null, groups)))
  useEffect(() => {
    if (data && !readId && current !== selected) onSelect(current)
  }, [data, readId, current, selected, onSelect])
  const job = groups.flatMap((group) => group.rows).find((row) => row.job.id === current)?.job
  return (
    <ListDetail
      listLabel="Brain lanes"
      detailLabel="Lane detail"
      open={!!current}
      onBack={() => onSelect(null)}
      backLabel="Lanes"
      list={
        <>
          {error && (
            <p role="status" className="p-3">
              {error} <Button onClick={retry}>Retry</Button>
            </p>
          )}
          {!history && !error && (
            <p role="status" className="p-3">
              Loading read lanes…
            </p>
          )}
          {!!groups.length && (
            <BrainInbox
              groups={groups}
              jobs={jobs}
              selected={readId ? null : current}
              onSelect={onSelect}
              now={now}
            />
          )}
          {history && !groups.length && (
            <p className="text-text-tertiary p-3 text-sm">
              Right-click a lane and choose Queue for knowledge extraction.
            </p>
          )}
          {history?.more && (
            <p className="text-text-tertiary p-3 text-sm">Showing the newest 200 reads.</p>
          )}
        </>
      }
      detail={(back) => (
        <div className="brain-lane-detail h-full min-w-0 overflow-y-auto [overflow-wrap:anywhere]">
          {back}
          {current && (
            <BrainLaneDetail
              key={current}
              jobId={current}
              job={job}
              readOnly={!!readId}
              now={now}
              onMemory={onMemory}
            />
          )}
        </div>
      )}
    />
  )
}

function useReadingClock(running: boolean): number {
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [running])
  return now
}
