import { useCallback } from 'react'
import type { BrainJob } from '@shared/brain'
import { ipcErrorText } from '@shared/errors'
import { Button } from '@/components/form'
import { PhosphorLoader } from '@/components/PhosphorLoader'
import { useBrain } from '../useBrain'
import { useBrainModelName } from '../useBrainModelName'
import { useBrainResource } from '../useBrainResource'
import { ExtractionOutcomes } from '../BrainExtraction'
import { ExtractionSource } from '../ExtractionSource'
import { ExtractionCalls } from '../ExtractionCalls'
import { BRAIN_PROGRESS_STAGES, BRAIN_STAGE_LABELS, progressLine } from '../jobProgress'
import { agoWords, durationWords } from '../jobProgress'
import { attemptStartedAt, laneLine } from './laneGroups'
import { brainLaneTitle } from '../laneTitle'

/** "Claude Opus 5.5 · Reading for 3 min", "Queued 2 h ago · 1 ahead": honest, never negative. */
export function jobHeadline(job: BrainJob, model: string, now: number, ahead: number): string {
  const started = attemptStartedAt(job)
  const state =
    job.state === 'running'
      ? started === null
        ? 'Reading'
        : `Reading for ${durationWords(now - started)}`
      : job.state === 'refreshing' || job.state === 'waiting' || job.state === 'queued'
        ? laneLine(job, now, ahead)
        : job.state === 'failed'
          ? `Failed${job.finishedAt === null ? '' : ` ${agoWords(now - job.finishedAt)}`}`
          : ''
  return [model, state].filter(Boolean).join(' · ')
}

/** A read in progress, waiting, queued or failed: where it is, and what can be done. */
export function JobDetail({
  job,
  now,
  ahead,
  onMemory,
}: {
  job: BrainJob
  now: number
  ahead: number
  onMemory: (id: string, label: string) => void
}): React.JSX.Element {
  const model = useBrainModelName(job.model)
  return (
    <section aria-label={JOB_LABELS[job.state] ?? 'Reading lane'} className="space-y-4 p-4">
      <header>
        <h2 className="text-xl font-semibold">{brainLaneTitle(job.title)}</h2>
        <p className="text-text-tertiary text-sm">{jobHeadline(job, model, now, ahead)}</p>
      </header>
      {job.state === 'failed' ? (
        <p role="alert" className="text-danger whitespace-pre-wrap">
          {job.error ?? 'The read failed'}
        </p>
      ) : job.state === 'running' ? (
        <ReadingSteps job={job} />
      ) : job.state === 'refreshing' ? (
        <p className="text-text-secondary">
          Brain changed since this lane was read, so it is checking the review again. Nothing to do:
          Brain Agent reviews this read in the next Defrag.
        </p>
      ) : null}
      <JobActions job={job} />
      <LiveExtraction job={job} onMemory={onMemory} />
    </section>
  )
}
const JOB_LABELS: Partial<Record<BrainJob['state'], string>> = {
  failed: 'Failed read',
  refreshing: 'Refreshing review',
}

/** Retry a failed read; cancel one in progress. A refreshing review waits for Defrag. */
export function JobActions({ job }: { job: BrainJob }): React.JSX.Element | null {
  const saving = useBrain((s) => s.saving)
  if (job.state === 'refreshing') return null
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
