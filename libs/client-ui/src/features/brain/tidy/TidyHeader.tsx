import { useCallback } from 'react'
import { useBrainResource } from '../useBrainResource'
import type { BrainTidyPage } from '@shared/brain-tidy'
import { Button } from '@/components/form'
import { relativeTime } from '@/lib/time'
import { useBrain } from '../useBrain'
import { useBrainModelName } from '../useBrainModelName'

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
    case 'done':
      return `Found ${run.suggestions} things to tidy and folded ${run.folded} exact repeats.`
    case 'cancelled':
      return `Tidy cancelled after checking ${run.checked} of ${run.total} pairs.`
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

function tidyCoverage({ coverage }: BrainTidyPage): string {
  if (coverage.startedAt === null) return ''
  const covered = coverage.memories.toLocaleString(),
    total = coverage.totalMemories.toLocaleString()
  const line =
    coverage.phase === 'done'
      ? `Checked all ${total} memories and ${coverage.totalEntities.toLocaleString()} people and things`
      : `Checked ${covered} of ${total} memories so far`
  return `${line}${coverage.finishedAt ? ` · ${relativeTime(coverage.finishedAt)}` : ''}`
}

export function TidyHeader({
  page,
  active,
  busy,
  onRun,
  onCancel,
}: {
  page: BrainTidyPage | null
  active: boolean
  busy: boolean
  onRun: () => void
  onCancel: () => void
}): React.JSX.Element {
  const status = useBrain((s) => s.status)!
  const history = useBrainResource(
    useCallback(() => window.phosphor.invoke('brain:history', 1), []),
    active && !status.prefs.model,
  )
  const model = useBrainModelName(status.prefs.model ?? history.data?.items[0]?.job.model ?? '')
  const running = status.tidy.running
  const retry = !!page?.run && ['failed', 'skipped', 'interrupted'].includes(page.run.state)
  const tooltip = model
    ? `Brain looks for repeats on this computer, then sends up to 40 pairs of memories or names to ${model} to judge them.`
    : 'Brain looks for repeats on this computer. When a reader model is available, it sends up to 40 pairs of memories or names to that model to judge them. Otherwise the model check is skipped.'
  return (
    <header className="border-border flex flex-wrap items-center gap-3 border-b p-3 [overflow-wrap:anywhere]">
      <Button disabled={busy || running} tooltip={tooltip} onClick={onRun}>
        Tidy now
      </Button>
      <div className="text-text-secondary min-w-0 flex-1 text-sm">
        {page?.run?.state === 'skipped' && <p>{tidyCoverage(page)}</p>}
        <p role="status">{tidyStatus(page)}</p>
        {page?.run && !running && page.run.state !== 'skipped' && <p>{tidyCoverage(page)}</p>}
        {!!page?.coverage.limitedChecks && (
          <p>
            {page.coverage.limitedChecks.toLocaleString()} checks were cut short to stay fast, so a
            repeat could be missed there.
          </p>
        )}
      </div>
      {running && (
        <Button disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      )}
      {history.error && (
        <p role="status">
          {history.error} <Button onClick={history.retry}>Retry reader model</Button>
        </p>
      )}
      {retry && (
        <Button disabled={busy} onClick={onRun}>
          Run it again
        </Button>
      )}
    </header>
  )
}
