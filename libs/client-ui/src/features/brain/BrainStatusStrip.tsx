import { useEffect, useState } from 'react'
import type { BrainAgentRun } from '@shared/brain-agent'
import { ipcErrorText } from '@shared/errors'
import { Button } from '@/components/form'
import { PhosphorLoader } from '@/components/PhosphorLoader'
import { TooltipButton } from '@/components/Tooltip'
import { formatCount } from '@/lib/format'
import { brainToast, mutateBrain, useBrain } from './useBrain'
import { progressLine, agoWords, durationWords } from './jobProgress'
import { brainLaneTitle } from './laneTitle'
import { agentResult } from './agentStatus'
import { openBrainSource } from './openBrainSource'

/** The shared read queue and its latest Defrag, without a second model-check surface. */
export function BrainStatusStrip({ onLanes }: { onLanes: () => void }): React.JSX.Element | null {
  const status = useBrain((s) => s.status)
  const jobs = status?.jobs ?? []
  const run = status?.agent.run
  const reading = jobs.find((job) => job.state === 'running')
  const refreshing = jobs.find((job) => job.state === 'refreshing' && job.runStartedAt !== null)
  const queued = jobs.filter((job) => job.state === 'queued' || job.state === 'waiting').length
  if (!reading && !refreshing && !queued && !run) return null
  return (
    <div
      role="status"
      className="border-border bg-bg-secondary/60 text-text-secondary flex shrink-0 flex-col gap-1 border-b px-4 py-1.5 text-sm"
    >
      {(reading || refreshing || queued > 0) && (
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {(reading || refreshing) && <PhosphorLoader size={14} decorative />}
          <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
            {reading ? (
              <>
                Reading <b className="text-text font-medium">{brainLaneTitle(reading.title)}</b>
                {reading.progress && ` · ${progressLine(reading.progress)}`}
                {queued > 0 && ` · ${queued} queued`}
              </>
            ) : refreshing ? (
              <>
                Refreshing the review of{' '}
                <b className="text-text font-medium">{brainLaneTitle(refreshing.title)}</b>
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
      {run && <AgentRunLine key={run.id} run={run} reading={reading?.title ?? null} />}
    </div>
  )
}

function AgentRunLine({
  run,
  reading,
}: {
  run: BrainAgentRun
  reading: string | null
}): React.JSX.Element {
  const [now, setNow] = useState(Date.now())
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const active = run.state === 'queued' || run.state === 'running'
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15000)
    return () => clearInterval(timer)
  }, [])
  const perform = async (action: 'stop' | 'undo' | 'open'): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      if (action === 'open' && run.sessionPath) await openBrainSource(run.sessionPath)
      if (action === 'stop') await mutateBrain(() => window.phosphor.invoke('brain:defragStop'))
      if (action === 'undo') {
        const result = await mutateBrain(() => window.phosphor.invoke('brain:undoRun', run.id))
        brainToast(
          `Undid ${formatCount(result.undone, 'change')}.${result.kept ? ` ${formatCount(result.kept, 'stays', 'stay')}: erasures, and changes later edits use.` : ''}`,
        )
      }
    } catch (cause) {
      setError(ipcErrorText(cause))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      {active && <PhosphorLoader size={14} decorative />}
      <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{runLine(run, reading, now)}</span>
      <Button
        size="xs"
        disabled={busy || !run.sessionPath}
        tooltip={
          run.sessionPath ? 'Open Brain Agent’s lane' : 'The Brain lane is not available yet.'
        }
        onClick={() => {
          void perform('open')
        }}
      >
        Brain lane
      </Button>
      {active ? (
        <Button
          size="xs"
          disabled={busy}
          onClick={() => {
            void perform('stop')
          }}
        >
          Stop
        </Button>
      ) : (
        run.undoable > 0 && (
          <Button
            size="xs"
            disabled={busy}
            onClick={() => {
              void perform('undo')
            }}
          >
            Undo run
          </Button>
        )
      )}
      {error && (
        <span role="alert" className="text-danger">
          {error}
        </span>
      )}
    </div>
  )
}

function runLine(run: BrainAgentRun, reading: string | null, now: number): string {
  if (run.state === 'queued')
    return reading
      ? `Defrag starts after Brain finishes reading ${brainLaneTitle(reading)}`
      : 'Defrag starts after the reads already queued'
  if (run.state === 'running') {
    const elapsed = now - (run.startedAt ?? now)
    return `Brain Agent is defragging · ${run.decided} of ${run.total}${elapsed >= 60_000 ? ` · ${durationWords(elapsed)}` : ''}`
  }
  return [
    agentResult(run),
    run.finishedAt === null ? '' : agoWords(now - run.finishedAt),
    run.state === 'stopped'
      ? 'stopped'
      : run.state === 'failed'
        ? (run.error ?? 'Defrag failed.')
        : '',
    run.rulesChanged ? 'Its rules changed during the run.' : '',
  ]
    .filter(Boolean)
    .join(' · ')
}
