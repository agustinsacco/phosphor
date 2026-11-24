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
export function progressLine(progress: NonNullable<BrainJob['progress']>): string {
  const label = BRAIN_STAGE_LABELS[progress.stage]
  return progress.stage === 'extract' || progress.total > 1
    ? `${label} · part ${Math.max(1, progress.done)} of ${progress.total}`
    : label
}
/** "less than a minute", "3 min", "2 h 5 min", "3 days": never negative, never "241:11". */
export function durationWords(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000)
  if (minutes < 1) return 'less than a minute'
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return minutes % 60 ? `${hours} h ${minutes % 60} min` : `${hours} h`
  return formatCount(Math.floor(hours / 24), 'day')
}

/** A model call's length: "42 s" under a minute, then as durationWords ("4 h 1 min"). */
export function callDuration(ms: number): string {
  const seconds = Math.floor(Math.max(0, ms) / 1000)
  return seconds < 60 ? `${Math.max(1, seconds)} s` : durationWords(ms)
}

export function agoWords(ms: number): string {
  return ms < 60_000 ? 'just now' : `${durationWords(ms)} ago`
}
