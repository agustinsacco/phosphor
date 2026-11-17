import { useCallback } from 'react'
import type { BrainTidyPage } from '@shared/brain-tidy'
import { Button } from '@/components/form'
import { formatCount } from '@/lib/format'
import { useBrain } from '../useBrain'
import { useBrainModelName } from '../useBrainModelName'
import { useBrainResource } from '../useBrainResource'
import { useTidyActions } from '../tidy/useTidyActions'
import { tidyCoverage, tidyStatus } from '../tidy/tidyStatus'

/** Under the queue: start the model check, and the last run's result in one line. */
export function TidyRunControls({
  page,
  reload,
}: {
  page: BrainTidyPage | null
  reload: () => Promise<BrainTidyPage | null>
}): React.JSX.Element {
  const status = useBrain((s) => s.status)!
  const history = useBrainResource(
    useCallback(() => window.phosphor.invoke('brain:history', 1), []),
    !status.prefs.model,
  )
  const model = useBrainModelName(status.prefs.model ?? history.data?.items[0]?.job.model ?? '')
  const actions = useTidyActions({ detail: null, page, reload })
  const running = status.tidy.running
  const tooltip = model
    ? `Brain looks for repeats on this computer, then sends up to 40 pairs of memories or names to ${model} to judge them.`
    : 'Brain looks for repeats on this computer. When a reader model is available, it sends up to 40 pairs of memories or names to that model to judge them. Otherwise the model check is skipped.'
  const coverage = page?.run && !running ? tidyCoverage(page) : ''
  return (
    <section aria-label="Tidy check" className="border-border space-y-1 border-t p-3 text-sm">
      <Button
        size="sm"
        disabled={actions.busy || running}
        tooltip={tooltip}
        onClick={() => actions.run()}
      >
        {model ? `Check with ${model}` : 'Check for repeats'}
      </Button>
      <p role="status" className="text-text-secondary">
        {tidyStatus(page)}
      </p>
      {coverage && <p className="text-text-tertiary">{coverage}</p>}
      {!!page?.coverage.limitedChecks && (
        <p className="text-text-tertiary">
          {formatCount(page.coverage.limitedChecks, 'check was', 'checks were')} cut short to stay
          fast, so a repeat could be missed there.
        </p>
      )}
      {actions.message && (
        <p role="alert" className="text-danger">
          {actions.message}
        </p>
      )}
      {history.error && (
        <p role="status">
          {history.error} <Button size="xs" onClick={history.retry}>Retry</Button>
        </p>
      )}
    </section>
  )
}
