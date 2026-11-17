import type { BrainJob, BrainJobStage, BrainExtractionCall } from '@shared/brain'
import { formatCount } from '@/lib/format'

export const BRAIN_STAGE_LABELS: Record<BrainJobStage | BrainExtractionCall['stage'], string> = {
  prepare: 'Prepare',
  extract: 'Read the conversation',
  links: 'Find relationships',
  identity: 'Match people and things',
  reconcile: 'Compare with what Brain knows',
  embed: 'Index',
  repair: 'Repair the response',
}
export const BRAIN_PROGRESS_STAGES: BrainJobStage[] = [
  'prepare',
  'extract',
  'identity',
  'reconcile',
  'embed',
]
export function elapsedTime(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}
export function progressLine(progress: NonNullable<BrainJob['progress']>): string {
  const label = BRAIN_STAGE_LABELS[progress.stage]
  return progress.stage === 'extract' || progress.total > 1
    ? `${label} · part ${Math.max(1, progress.done)} of ${progress.total}`
    : label
}
export function jobLine(job: BrainJob, ahead: number, now: number): string {
  switch (job.state) {
    case 'waiting':
      return 'Waits until the lane is idle'
    case 'queued':
      return ahead ? `Queued · ${ahead} ahead` : 'Queued · starting'
    case 'running':
      return job.progress
        ? progressLine(job.progress)
        : `Reading a private copy · ${elapsedTime(now - (job.startedAt ?? now))}`
    case 'review':
      return `${formatCount(job.memories, 'memory', 'memories')} to review`
    case 'empty':
      return 'Nothing kept'
    case 'failed':
      return job.error ?? 'Knowledge extraction failed'
    case 'done':
      return ''
  }
}
