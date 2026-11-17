import { useCallback, useState } from 'react'
import type { BrainJob } from '@shared/brain'
import { Button } from '@/components/form'
import { PhosphorLoader } from '@/components/PhosphorLoader'
import { useBrain } from './useBrain'
import { useBrainModelName } from './useBrainModelName'
import { useBrainResource } from './useBrainResource'
import { BrainReview } from './BrainReview'
import { BrainExtraction, ExtractionOutcomes } from './BrainExtraction'
import { ExtractionSource } from './ExtractionSource'
import { ipcErrorText } from '@shared/errors'
import { ExtractionCalls } from './ExtractionCalls'
import {
  BRAIN_PROGRESS_STAGES,
  BRAIN_STAGE_LABELS,
  elapsedTime,
  jobLine,
  progressLine,
} from './jobProgress'

export function BrainLaneDetail({
  jobId,
  job,
  readOnly,
  now,
  onMemory,
}: {
  jobId: string
  job: BrainJob | undefined
  readOnly: boolean
  now: number
  onMemory: (id: string, label: string) => void
}): React.JSX.Element {
  const [showRead, setShowRead] = useState(false)
  const [reviewed, setReviewed] = useState(job?.state === 'review')
  if (job?.state === 'review' && !reviewed) setReviewed(true)
  if (job && job.state !== 'review' && job.state !== 'running' && reviewed) setReviewed(false)
  if (readOnly || showRead || job?.state === 'done' || job?.state === 'empty')
    return (
      <>
        {job?.state === 'empty' && <JobActions job={job} />}
        <BrainExtraction
          jobId={jobId}
          onMemory={onMemory}
          onBack={showRead ? () => setShowRead(false) : undefined}
        />
      </>
    )
  if (job?.state === 'review' || (reviewed && job?.state === 'running'))
    return <BrainReview jobId={jobId} onClose={() => {}} onExtraction={() => setShowRead(true)} />
  if (!job)
    return (
      <p role="status" className="p-4">
        Loading read…
      </p>
    )
  return <ReadingDetail job={job} now={now} onMemory={onMemory} />
}
function ReadingDetail({
  job,
  now,
  onMemory,
}: {
  job: BrainJob
  now: number
  onMemory: (id: string, label: string) => void
}): React.JSX.Element {
  const model = useBrainModelName(job.model)
  return (
    <section
      aria-label={job.state === 'failed' ? 'Failed read' : 'Reading lane'}
      className="space-y-4 p-4"
    >
      <header>
        <h2 className="text-xl font-semibold">{job.title}</h2>
        <p className="text-text-tertiary text-sm">
          {model && `${model} · `}
          {job.startedAt !== null
            ? `started ${elapsedTime(now - job.startedAt)} ago`
            : jobLine(job, 0, now)}
        </p>
      </header>
      {job.state === 'failed' ? (
        <p role="alert" className="text-danger whitespace-pre-wrap">
          {job.error ?? 'Knowledge extraction failed'}
        </p>
      ) : (
        <ReadingSteps job={job} />
      )}
      <JobActions job={job} />
      <LiveExtraction job={job} onMemory={onMemory} />
    </section>
  )
}
function JobActions({ job }: { job: BrainJob }): React.JSX.Element {
  const saving = useBrain((s) => s.saving)
  return (
    <div className="flex flex-wrap gap-2">
      {job.state === 'failed' && (
        <Button
          disabled={saving}
          onClick={() => {
            void useBrain.getState().retry(job.id)
          }}
        >
          Retry
        </Button>
      )}
      <Button
        disabled={saving}
        onClick={() => {
          void useBrain.getState().cancel(job.id)
        }}
      >
        {job.state === 'failed' || job.state === 'empty' ? 'Dismiss' : 'Cancel'}
      </Button>
    </div>
  )
}
function ReadingSteps({ job }: { job: BrainJob }): React.JSX.Element {
  const current = job.progress ? BRAIN_PROGRESS_STAGES.indexOf(job.progress.stage) : -1
  return (
    <ol aria-label="Reading steps" className="space-y-2">
      {BRAIN_PROGRESS_STAGES.map((stage, index) => (
        <li
          key={stage}
          aria-current={index === current ? 'step' : undefined}
          className={
            index <= current
              ? 'text-text-secondary flex items-center gap-2'
              : 'text-text-tertiary flex items-center gap-2'
          }
        >
          {index === current ? (
            <PhosphorLoader size={16} label="Current step" />
          ) : (
            <span aria-label={index < current ? 'Done' : 'Pending'}>
              {index < current ? '✓' : '○'}
            </span>
          )}
          {index === current && job.progress
            ? progressLine(job.progress)
            : BRAIN_STAGE_LABELS[stage]}
        </li>
      ))}
    </ol>
  )
}
function LiveExtraction({
  job,
  onMemory,
}: {
  job: BrainJob
  onMemory: (id: string, label: string) => void
}): React.JSX.Element {
  const load = useCallback(async () => {
    try {
      return { record: await window.phosphor.invoke('brain:extraction', job.id) }
    } catch (cause) {
      // The first record is saved only after a call returns, not when the job starts.
      if (ipcErrorText(cause) === 'Brain extraction not found (dismissed or expired).')
        return { record: null }
      throw cause
    }
  }, [job.id])
  const { data, error, retry } = useBrainResource(load, job.startedAt !== null, JSON.stringify(job))
  if (job.startedAt === null || (data && !data.record))
    return <p className="text-text-tertiary text-sm">No calls yet.</p>
  if (!data?.record)
    return (
      <p role="status">
        {error || 'Loading calls…'} {error && <Button onClick={retry}>Retry</Button>}
      </p>
    )
  return (
    <>
      <ExtractionOutcomes data={data.record} onMemory={onMemory} />
      <ExtractionCalls data={data.record} />
      <ExtractionSource source={data.record.source} />
    </>
  )
}
