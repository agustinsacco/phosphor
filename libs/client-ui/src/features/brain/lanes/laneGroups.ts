import type { BrainExtractionOutcome, BrainHistory, BrainJob } from '@shared/brain'
import type { BrainTidyOperation } from '@shared/brain-tidy'
import { formatCount } from '@/lib/format'
import { agoWords, durationWords, progressLine } from '../jobProgress'

/**
 * Every row the Lanes list can select. A change with a null id is the newest one, for a
 * notice that opens Recent changes before they have loaded. `never` is the lanes Brain
 * does not read.
 */
export type LaneSelection =
  { type: 'job'; id: string } | { type: 'change'; id: string | null } | { type: 'never' }
export type LaneGroupId = 'reading' | 'refreshing' | 'queued' | 'failed' | 'read'
export const LANE_GROUP_LABELS: Record<LaneGroupId, string> = {
  reading: 'Reading',
  refreshing: 'Refreshing',
  queued: 'Queued',
  failed: 'Failed',
  read: 'Read',
}
export interface LaneRow {
  job: BrainJob
  /** Memories still in Brain from this read; a running job's count is its proposal size. */
  memories: number
  replaceable: number
}
export interface LaneGroup {
  id: LaneGroupId
  label: string
  rows: LaneRow[]
}

const FINISHED: readonly BrainJob['state'][] = ['done', 'empty']

export function laneGroups(jobs: BrainJob[], history: BrainHistory | null): LaneGroup[] {
  const row = (job: BrainJob): LaneRow => ({ job, memories: job.memories, replaceable: 0 })
  const read = new Map((history?.items ?? []).map((item) => [item.job.id, item]))
  for (const job of jobs)
    if (FINISHED.includes(job.state) && !read.has(job.id))
      read.set(job.id, { job, memories: 0, replaceable: 0 })
  const groups: Record<LaneGroupId, LaneRow[]> = {
    reading: jobs.filter((job) => job.state === 'running').map(row),
    refreshing: [],
    queued: jobs.filter((job) => job.state === 'queued' || job.state === 'waiting').map(row),
    failed: jobs.filter((job) => job.state === 'failed').map(row),
    read: [...read.values()].toSorted((a, b) => (b.job.finishedAt ?? 0) - (a.job.finishedAt ?? 0)),
  }
  return (Object.keys(LANE_GROUP_LABELS) as LaneGroupId[])
    .map((id) => ({ id, label: LANE_GROUP_LABELS[id], rows: groups[id] }))
    .filter((group) => group.rows.length > 0)
}

export function laneKey(selection: LaneSelection | null): string {
  return !selection
    ? ''
    : selection.type === 'never'
      ? 'never'
      : `${selection.type}:${selection.id ?? ''}`
}

/**
 * Keep a selection that still exists; otherwise the first read in progress, then the newest.
 * A read the list never showed (older than its newest 200) stays selected: it was asked for
 * by id. One the list did show and no longer does was cancelled or dismissed.
 */
export function keepLaneSelection(
  selected: LaneSelection | null,
  groups: LaneGroup[],
  changes: BrainTidyOperation[],
  listed: ReadonlySet<string> = new Set(),
): LaneSelection | null {
  const jobs = groups.flatMap((group) => group.rows.map((row) => row.job.id))
  if (selected?.type === 'never') return selected
  if (selected?.type === 'job' && (jobs.includes(selected.id) || !listed.has(selected.id)))
    return selected
  if (selected?.type === 'change') {
    const change = changes.find((item) => selected.id === null || item.id === selected.id)
    if (change) return { type: 'change', id: change.id }
  }
  const first = groups[0]?.rows[0]?.job.id
  return first ? { type: 'job', id: first } : null
}

/** When this attempt started: a resume, retry or refresh restarts the clock. */
export function attemptStartedAt(job: BrainJob): number | null {
  return job.startedAt
}

/** A row's second line: what the job is doing now, in honest time. */
export function laneLine(job: BrainJob, now: number, ahead: number): string {
  switch (job.state) {
    case 'running': {
      const started = attemptStartedAt(job)
      const elapsed = started === null ? '' : ` · ${durationWords(now - started)}`
      return `${job.progress ? progressLine(job.progress) : 'Reading'}${elapsed}`
    }
    case 'waiting':
      return 'Waits until the lane is idle'
    case 'queued':
      return `Queued ${agoWords(now - job.queuedAt)}${ahead ? ` · ${ahead} ahead` : ''}`
    case 'failed':
      return job.error ?? 'The read failed'
    case 'empty':
      return 'Nothing worth keeping'
    default:
      return ''
  }
}

/** Jobs ahead of this one in the reader's queue. */
export function jobsAhead(jobs: BrainJob[], id: string): number {
  const at = jobs.findIndex((job) => job.id === id)
  return jobs
    .slice(0, Math.max(0, at))
    .filter((job) => job.state === 'queued' || job.state === 'running').length
}

/** What one finished read did: kept, confirmed what Brain knew, or left out. */
export function readCounts(outcomes: BrainExtractionOutcome[]): {
  kept: number
  confirmed: number
  left: number
} {
  const count = (statuses: BrainExtractionOutcome['status'][]): number =>
    outcomes.filter((outcome) => statuses.includes(outcome.status) && !outcome.removed).length
  return {
    kept: count(['kept', 'enriches']),
    confirmed: count(['reconfirms', 'folded']),
    left: outcomes.filter((o) => o.status === 'held' || o.status === 'dropped').length,
  }
}

/** A finished read's second line: what is left of it, and when. */
export function readLine(row: LaneRow, now: number): string {
  if (row.job.state === 'empty') return 'Nothing worth keeping'
  const when = row.job.finishedAt === null ? '' : ` · ${agoWords(now - row.job.finishedAt)}`
  return `${formatCount(row.memories, 'memory', 'memories')}${when}`
}
