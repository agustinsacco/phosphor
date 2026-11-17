import type { BrainTidyPage } from '@shared/brain-tidy'
import { relativeTime } from '@/lib/time'
import { formatCount } from '@/lib/format'
import { tidyFindings } from './tidyWording'

/** One line for the latest Tidy run, or the coverage of the current pass when none ran. */
export function tidyStatus(page: BrainTidyPage | null): string {
  if (!page) return 'Loading Tidy…'
  const run = page.run
  switch (run?.state) {
    case 'queued':
      return 'Waiting for the lane reader…'
    case 'sweeping':
      return 'Looking for repeats…'
    case 'checking':
      return `Checking ${run.checked} of ${run.total}`
    case 'done': {
      const findings = tidyFindings(run.suggestions, run.folded)
      return findings ? `${findings[0]!.toUpperCase()}${findings.slice(1)}.` : 'Nothing to tidy.'
    }
    case 'cancelled':
      return `Tidy cancelled after checking ${run.checked.toLocaleString()} of ${formatCount(run.total, 'pair')}.`
    case 'skipped':
      return run.message ?? 'The model check was skipped.'
    case 'interrupted':
      return run.error ?? 'Tidy was interrupted when Phosphor closed.'
    case 'failed':
      return run.error ?? 'Tidy could not finish.'
    default:
      return tidyCoverage(page) || 'Look for repeats and disagreements.'
  }
}

export function tidyCoverage({ coverage }: BrainTidyPage): string {
  if (coverage.startedAt === null) return ''
  const total = formatCount(coverage.totalMemories, 'memory', 'memories')
  const line =
    coverage.phase === 'done'
      ? `Checked all ${total} and ${formatCount(coverage.totalEntities, 'person or thing', 'people and things')}`
      : `Checked ${coverage.memories.toLocaleString()} of ${total} so far`
  return `${line}${coverage.finishedAt ? ` · ${relativeTime(coverage.finishedAt)}` : ''}`
}
