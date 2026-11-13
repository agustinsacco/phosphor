import type { BrainJob } from '@shared/brain'
import { formatCount } from '@/lib/format'

export function elapsedTime(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

export function jobLine(job: BrainJob, ahead: number, now: number): string {
  switch (job.state) {
    case 'waiting':
      return 'Waits until the lane is idle'
    case 'queued':
      return ahead ? `Queued · ${ahead} ahead` : 'Queued · starting'
    case 'running':
      if (job.progress) return progressLine(job.progress)
      return `Reading a private copy · ${elapsedTime(now - (job.startedAt ?? now))}`
    case 'review':
      return `${formatCount(job.memories, 'memory', 'memories')} to review`
    case 'empty':
      return 'Nothing new worth keeping'
    case 'failed':
      return job.error ?? 'Knowledge extraction failed'
    case 'done':
      return ''
  }
}

function progressLine(progress: NonNullable<BrainJob['progress']>): string {
  const labels = {
    prepare: 'Preparing lane',
    extract: 'Reading window',
    identity: 'Matching entities',
    parents: 'Finding parents',
    reconcile: 'Reconciling memories',
    embed: 'Indexing memories',
  }
  return `${labels[progress.stage]} ${progress.done} of ${progress.total}`
}
