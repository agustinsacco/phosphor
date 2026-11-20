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
export type LaneGroupId = 'waiting' | 'reading' | 'queued' | 'failed' | 'read'
export const LANE_GROUP_LABELS: Record<LaneGroupId, string> = {
  waiting: 'Waiting for Defrag',
  reading: 'Reading',
  queued: 'Queued',
  failed: 'Failed',
  read: 'Read',
}
export interface LaneRow {
  job: BrainJob
  /** Memories this read kept that are still in Brain; a running job's count is its proposal size. */
  memories: number
  /** Lane-wide: what Read again would replace. */
  replaceable: number
}
export interface LaneGroup {
  id: LaneGroupId
  label: string
  rows: LaneRow[]
}

/** The Lanes group of a job; waiting reads come first. */
function laneGroupOf(job: BrainJob): LaneGroupId | null {
  // Exhaustive: a new job state must choose its group here.
  switch (job.state) {
    case 'running':
      return 'reading'
    case 'refreshing':
    case 'review':
      return 'waiting'
    case 'queued':
    case 'waiting':
      return 'queued'
    case 'failed':
      return 'failed'
    case 'done':
    case 'empty':
    case 'rejected':
      return 'read'
  }
}

/** A read that ended: kept, empty or rejected. Its detail is the finished read. */
export function finishedRead(job: BrainJob): boolean {
  return laneGroupOf(job) === 'read'
}

export function laneGroups(jobs: BrainJob[], history: BrainHistory | null): LaneGroup[] {
  const read = new Map((history?.items ?? []).map((item) => [item.job.id, item]))
  const groups: Record<LaneGroupId, LaneRow[]> = {
    waiting: [],
    reading: [],
    queued: [],
    failed: [],
    read: [],
  }
  for (const job of jobs) {
    const group = laneGroupOf(job)
    if (group === 'read') {
      if (!read.has(job.id)) read.set(job.id, { job, memories: 0, replaceable: 0 })
    } else if (group) groups[group].push({ job, memories: job.memories, replaceable: 0 })
  }
  groups.read = [...read.values()].toSorted(
    (a, b) => (b.job.finishedAt ?? 0) - (a.job.finishedAt ?? 0),
  )
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

/**
 * When the current attempt started: a resume, retry or refresh restarts the clock. Only a
 * running or refreshing job has one; `startedAt` is the first start and would overstate it.
 */
export function attemptStartedAt(job: BrainJob): number | null {
  return job.state === 'running' || job.state === 'refreshing' ? job.runStartedAt : null
}

/** A row's second line: what the job is doing now, in honest time. */
export function laneLine(job: BrainJob, now: number, ahead: number): string {
  const started = attemptStartedAt(job)
  switch (job.state) {
    case 'running': {
      const elapsed = started === null ? '' : ` · ${durationWords(now - started)}`
      return `${job.progress ? progressLine(job.progress) : 'Reading'}${elapsed}`
    }
    case 'refreshing':
      // A refresh waits its turn behind a running read before its attempt starts.
      return started === null
        ? 'Waits to refresh'
        : `Refreshing for ${durationWords(now - started)}`
    case 'waiting':
      return 'Waits until the lane is idle'
    case 'queued':
      return `Queued ${agoWords(now - job.queuedAt)}${ahead ? ` · ${ahead} ahead` : ''}`
    case 'failed':
      return job.error ?? 'The read failed'
    case 'empty':
      return 'Nothing worth keeping'
    case 'rejected':
      return 'Rejected'
    case 'review':
      return `${formatCount(job.memories, 'memory', 'memories')}${job.finishedAt === null ? '' : ` · read ${agoWords(now - job.finishedAt)}`}`
    case 'done':
      return ''
  }
}

/** Jobs the reader takes before this one: a read before it, and every review it refreshes. */
export function jobsAhead(jobs: BrainJob[], id: string): number {
  const at = jobs.findIndex((job) => job.id === id)
  return jobs.filter(
    (job, index) =>
      job.id !== id &&
      (job.state === 'refreshing' ||
        (index < at && (job.state === 'queued' || job.state === 'running'))),
  ).length
}

/** What one finished read did: kept, confirmed what Brain knew, or left out. */
export function readCounts(outcomes: BrainExtractionOutcome[]): {
  kept: number
  confirmed: number
  left: number
} {
  const counts = { kept: 0, confirmed: 0, left: 0 }
  for (const outcome of outcomes) {
    const status = outcome.status
    switch (status) {
      case 'kept':
      case 'enriches':
        if (!outcome.removed) counts.kept++
        break
      case 'reconfirms':
      case 'folded':
        if (!outcome.removed) counts.confirmed++
        break
      case 'held':
      case 'dropped':
        counts.left++
        break
      case 'noted':
        // A remark about the read: nothing was kept, confirmed or left out.
        break
      default:
        status satisfies never
    }
  }
  return counts
}

/** "Nov 12, 2026, 3:40 PM": a read's finish, precise enough to tell two reads a day apart. */
function readTime(ms: number): string {
  return new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

/**
 * What a read covered: the whole lane, or what came after the read it continues. That read is
 * often gone (a finished read replaces its lane's older one), so the date is shown when known.
 */
export function coverageLine(job: BrainJob, history: BrainHistory | null): string {
  if (job.fromLeafId === null) return 'Whole lane'
  const previous = history?.items.find(
    (item) =>
      item.job.id !== job.id &&
      item.job.sessionId === job.sessionId &&
      item.job.leafId === job.fromLeafId,
  )?.job.finishedAt
  return previous
    ? `New messages after ${readTime(previous)}`
    : 'New messages since the previous read'
}

/** A finished read's second line: what is left of what this read kept, and when. */
export function readLine(row: LaneRow, now: number): string {
  if (row.job.state === 'empty') return 'Nothing worth keeping'
  if (row.job.state === 'rejected') return 'Rejected'
  const when = row.job.finishedAt === null ? '' : ` · ${agoWords(now - row.job.finishedAt)}`
  return `${formatCount(row.memories, 'memory', 'memories')} from this read${when}`
}
