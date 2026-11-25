import { useEffect, useState } from 'react'
import type { BrainJob } from '@shared/brain'
import type { BrainAgentRun } from '@shared/brain-agent'
import { ipcErrorText } from '@shared/errors'
import { Button } from '@/components/form'
import { PhosphorLoader } from '@/components/PhosphorLoader'
import { formatCount } from '@/lib/format'
import { brainToast, mutateBrain, useBrain } from './useBrain'
import { progressLine, agoWords, durationWords } from './jobProgress'
import { brainLaneTitle } from './laneTitle'
import { agentResult } from './agentStatus'
import { openBrainSource } from './openBrainSource'

/**
 * What Brain is doing: the read in progress and how many wait, reads that failed with Retry
 * and Dismiss, and Brain Agent's run with Stop, Undo run and its lane.
 */
export function BrainStatusBar(): React.JSX.Element | null {
  const status = useBrain((s) => s.status)
  const jobs = status?.jobs ?? []
  const run = status?.agent.run
  const reading = jobs.find((job) => job.state === 'running')
  const queued = jobs.filter((job) => job.state === 'queued' || job.state === 'waiting').length
  const failed = jobs.filter((job) => job.state === 'failed' || job.state === 'empty')
  if (!reading && !queued && !failed.length && !run) return null
  return (
    <div role="status" aria-label="Brain status" className="brain-status-bar">
      {(reading || queued > 0) && (
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {reading && <PhosphorLoader size={14} decorative />}
          <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
            {reading ? (
              <>
                Reading <b className="text-text font-medium">{brainLaneTitle(reading.title)}</b>
                {reading.progress && ` · ${progressLine(reading.progress)}`}
                {queued > 0 && ` · ${queued} queued`}
              </>
            ) : (
              `${formatCount(queued, 'lane')} queued`
            )}
          </span>
        </div>
      )}
      {failed.map((job) => (
        <FailedReadLine key={job.id} job={job} />
      ))}
      {run && <AgentRunLine key={run.id} run={run} reading={reading?.title ?? null} />}
    </div>
  )
}

/** A read that failed or found nothing: why, and Retry or Dismiss. */
function FailedReadLine({ job }: { job: BrainJob }): React.JSX.Element {
  const saving = useBrain((s) => s.saving)
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
        <b className="text-text font-medium">{brainLaneTitle(job.title)}</b>
        {' · '}
        {job.state === 'empty' ? 'nothing worth keeping' : (job.error ?? 'the read failed')}
      </span>
      {job.state === 'failed' && (
        <Button
          size="xs"
          disabled={saving}
          onClick={() => {
            void useBrain.getState().retry(job.id)
          }}
        >
          Retry
        </Button>
      )}
      <Button
        size="xs"
        disabled={saving}
        onClick={() => {
          void useBrain.getState().cancel(job.id)
        }}
      >
        Dismiss
      </Button>
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
    return `Brain Agent is ${run.automatic ? 'checking new knowledge' : 'defragging'} · ${run.decided} of ${run.total}${elapsed >= 60_000 ? ` · ${durationWords(elapsed)}` : ''}`
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
