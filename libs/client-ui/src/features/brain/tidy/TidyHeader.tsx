import { useCallback } from 'react'
import { useBrainResource } from '../useBrainResource'
import type { BrainTidyPage } from '@shared/brain-tidy'
import { Button } from '@/components/form'
import { relativeTime } from '@/lib/time'
import { useBrain } from '../useBrain'
import { useBrainModelName } from '../useBrainModelName'

export function tidyStatus(page: BrainTidyPage | null): string {
  if (!page) return 'Loading Tidy…'
  const { run, coverage } = page
  if (run?.state === 'queued') return 'Waiting for the lane reader…'
  if (run?.state === 'sweeping') return 'Looking for repeats…'
  if (run?.state === 'checking') return `Checking ${run.checked} of ${run.total}`
  if (run?.error || run?.message) return run.error ?? run.message!
  if (run?.state === 'cancelled') return 'Tidy cancelled. You can continue with Tidy now.'
  if (!coverage.startedAt) return 'Look for repeats and disagreements.'
  const covered = coverage.memories.toLocaleString(),
    total = coverage.totalMemories.toLocaleString()
  const line =
    coverage.phase === 'done'
      ? `Checked all ${total} memories`
      : `Checked ${covered} of ${total} memories so far`
  return `${line}${coverage.finishedAt ? ` · ${relativeTime(coverage.finishedAt)}` : ''}${coverage.limitedChecks ? ' · Common-name groups were capped' : ''}`
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
  const retry = !!page?.run && !!(page.run.error || page.run.message) && !running
  const tooltip = model
    ? `Brain looks for repeats on this computer, then sends up to 40 pairs of memories or names to ${model} to judge them.`
    : 'Brain looks for repeats on this computer. When a reader model is available, it sends up to 40 pairs of memories or names to that model to judge them. Otherwise the model check is skipped.'
  return (
    <header className="border-border flex flex-wrap items-center gap-3 border-b p-3 [overflow-wrap:anywhere]">
      <Button disabled={busy || running} tooltip={tooltip} onClick={onRun}>
        Tidy now
      </Button>
      <p role="status" className="text-text-secondary min-w-0 flex-1 text-sm">
        {tidyStatus(page)}
      </p>
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
          Retry
        </Button>
      )}
    </header>
  )
}
