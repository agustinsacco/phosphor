import { useState } from 'react'
import type { BrainTidyPage } from '@shared/brain-tidy'
import { ipcErrorText } from '@shared/errors'
import { Button } from '@/components/form'
import { PhosphorLoader } from '@/components/PhosphorLoader'
import { TooltipButton } from '@/components/Tooltip'
import { formatCount } from '@/lib/format'
import { mutateBrain, useBrain } from './useBrain'
import { useBrainModelName } from './useBrainModelName'
import { progressLine } from './jobProgress'

/** One thin line under the tabs, only while Brain is reading a lane or checking pairs. */
export function BrainStatusStrip({
  page,
  onLanes,
}: {
  page: BrainTidyPage | null
  onLanes: () => void
}): React.JSX.Element | null {
  const jobs = useBrain((s) => s.status?.jobs ?? [])
  const checking = useBrain((s) => s.status?.tidy.running ?? false)
  const running = jobs.find((job) => job.state === 'running')
  const queued = jobs.filter((job) => job.state === 'queued' || job.state === 'waiting').length
  if (!running && !queued && !checking) return null
  return (
    <div
      role="status"
      className="border-border bg-bg-secondary/60 text-text-secondary flex shrink-0 flex-col gap-1 border-b px-4 py-1.5 text-sm"
    >
      {(running || queued > 0) && (
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {running && <PhosphorLoader size={14} decorative />}
          <span className="min-w-0 flex-1">
            {running ? (
              <>
                Reading <b className="text-text font-medium">{running.title}</b>
                {running.progress && ` · ${progressLine(running.progress)}`}
                {queued > 0 && ` · ${queued} queued`}
              </>
            ) : (
              `${formatCount(queued, 'lane')} queued`
            )}
          </span>
          <TooltipButton className="text-accent hover:underline" onClick={onLanes}>
            Lanes
          </TooltipButton>
        </div>
      )}
      {checking && <TidyCheckLine page={page} />}
    </div>
  )
}

function TidyCheckLine({ page }: { page: BrainTidyPage | null }): React.JSX.Element {
  const prefModel = useBrain((s) => s.status?.prefs.model ?? '')
  const model = useBrainModelName(prefModel)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const run = page?.run
  const cancel = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      await mutateBrain(() => window.phosphor.invoke('brain:tidyCancel'))
    } catch (cause) {
      setError(ipcErrorText(cause))
    } finally {
      setBusy(false)
    }
  }
  const line =
    run?.state === 'checking'
      ? `Checking ${run.checked} of ${formatCount(run.total, 'pair')}${model ? ` with ${model}` : ''}`
      : run?.state === 'queued'
        ? 'Tidy waits for the lane reader'
        : 'Looking for repeats'
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <PhosphorLoader size={14} decorative />
      <span className="min-w-0 flex-1">{line}</span>
      {error && <span role="alert">{error}</span>}
      <Button
        size="xs"
        disabled={busy}
        onClick={() => {
          void cancel()
        }}
      >
        Cancel
      </Button>
    </div>
  )
}
