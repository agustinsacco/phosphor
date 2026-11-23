import { useCallback, useState } from 'react'
import { brainLaneNeverRead } from '@shared/brain'
import { BRAIN_REVIEW_REFRESHING } from '@shared/brain-review'
import type { BrainExtractionView, BrainHistory, BrainJob, BrainProposalView } from '@shared/brain'
import { ipcErrorText } from '@shared/errors'
import { Button } from '@/components/form'
import { TooltipButton, TooltipSummary } from '@/components/Tooltip'
import { formatCount } from '@/lib/format'
import { relativeTime } from '@/lib/time'
import { useSessionsStore } from '@/stores/sessions'
import { useBrain } from '../useBrain'
import { useBrainModelName } from '../useBrainModelName'
import { useBrainResource } from '../useBrainResource'
import { BrainReadAgain } from '../BrainReadAgain'
import { ExtractionOutcomes } from '../BrainExtraction'
import { ExtractionCalls } from '../ExtractionCalls'
import { ExtractionSource } from '../ExtractionSource'
import { openBrainSource } from '../openBrainSource'
import { agoWords, durationWords } from '../jobProgress'
import { readTime } from '../readTime'
import { coverageLine, readCounts } from './laneGroups'
import { brainLaneTitle } from '../laneTitle'
import { MemoryQuotes } from '../MemoryQuotes'

/** A finished read: what it kept, what it covered, and the ways to read the lane again. */
export function ReadDetail({
  jobId,
  history,
  job,
  onMemory,
}: {
  jobId: string
  job?: BrainJob
  /** Finished reads, to date the read this one continues. */
  history: BrainHistory | null
  onMemory: (id: string, label: string) => void
}): React.JSX.Element {
  const [inspect, setInspect] = useState(false)
  const waiting = !!job && ['review', 'refreshing'].includes(job.state)
  const load = useCallback(() => window.phosphor.invoke('brain:extraction', jobId), [jobId])
  const { data, error, retry } = useBrainResource(load, !waiting || inspect)
  if (waiting && !inspect) return <WaitingRead job={job} onInspect={() => setInspect(true)} />
  if (!data)
    return (
      <p role="status" className="p-4">
        {error || 'Loading the read…'}{' '}
        {error && (
          <Button size="xs" onClick={retry}>
            Retry
          </Button>
        )}
      </p>
    )
  return (
    <>
      <FinishedRead data={data} history={history} onMemory={onMemory} />
      {waiting && (
        <Button size="xs" onClick={() => setInspect(false)}>
          Back to waiting read
        </Button>
      )}
    </>
  )
}

function FinishedRead({
  data,
  history,
  onMemory,
}: {
  data: BrainExtractionView
  history: BrainHistory | null
  onMemory: (id: string, label: string) => void
}): React.JSX.Element {
  const model = useBrainModelName(data.model)
  const counts = readCounts(data.outcomes)
  const rejected = data.job?.state === 'rejected'
  const took = readTime(data.calls)
  return (
    <article aria-label="Read detail" className="min-w-0 space-y-4 p-4">
      <header>
        <h2 className="text-xl font-semibold">{brainLaneTitle(data.title)}</h2>
        <p className="text-text-tertiary text-sm">
          {[
            model,
            took === null ? '' : `took ${durationWords(took)}`,
            relativeTime(data.finishedAt),
          ]
            .filter(Boolean)
            .join(' · ')}
        </p>
      </header>
      {data.error && (
        <p role="status" className="text-danger">
          {data.error}
        </p>
      )}
      {rejected ? (
        <p className="font-medium">Rejected · nothing was saved</p>
      ) : (
        <dl className="grid grid-cols-3 gap-2 text-center">
          <Count label="kept" value={counts.kept} />
          <Count label="confirmed what Brain knew" value={counts.confirmed} />
          <Count label="left out" value={counts.left} />
        </dl>
      )}
      {data.job && (
        <p className="text-text-secondary text-sm">Covered: {coverageLine(data.job, history)}</p>
      )}
      <ReadActions data={data} />
      {!rejected && <ReadMemories data={data} onMemory={onMemory} />}
      <details>
        <TooltipSummary className="cursor-pointer">What happened to each claim</TooltipSummary>
        <ExtractionOutcomes data={data} onMemory={onMemory} />
      </details>
      <ExtractionCalls data={data} />
      <ExtractionSource source={data.source} />
    </article>
  )
}

function Count({ label, value }: { label: string; value: number }): React.JSX.Element {
  return (
    <div className="border-border flex flex-col-reverse rounded-md border p-2">
      <dt className="text-text-tertiary text-sm">{label}</dt>
      <dd className="text-lg font-semibold tabular-nums">{value}</dd>
    </div>
  )
}

/** Read new messages, read again from the start, or open the lane. */
function ReadActions({ data }: { data: BrainExtractionView }): React.JSX.Element {
  const saving = useBrain((s) => s.saving)
  const [error, setError] = useState('')
  const grown = useLaneGrew(data.source.sessionPath, data.finishedAt)
  const folder = useBrain((s) => s.status?.agent.folder)
  const ownLane = useSessionsStore((s) =>
    Object.values(s.disk)
      .flat()
      .some((lane) => lane.path === data.source.sessionPath && lane.cwd === folder),
  )
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap gap-2">
        {!ownLane && data.job?.state === 'done' && data.source.exists && (
          <Button
            size="xs"
            variant="primary"
            disabled={saving || grown === false}
            tooltip={
              grown === false
                ? 'No new messages since this read'
                : 'Brain reads only the messages after this read'
            }
            onClick={() => {
              void useBrain
                .getState()
                .queue({ sessionPath: data.source.sessionPath, title: data.title })
            }}
          >
            Read new messages
          </Button>
        )}
        {!ownLane && data.job?.state === 'done' && (
          <BrainReadAgain
            job={data.job}
            memories={data.laneMemories}
            replaceable={data.replaceable}
          />
        )}
        {data.job?.state === 'empty' && (
          <Button
            size="xs"
            disabled={saving}
            tooltip="Take this read off the list"
            onClick={() => {
              void useBrain.getState().cancel(data.job!.id)
            }}
          >
            Dismiss
          </Button>
        )}
        {data.source.exists && (
          <Button
            size="xs"
            onClick={() => {
              setError('')
              openBrainSource(data.source.sessionPath).catch((cause: unknown) =>
                setError(ipcErrorText(cause)),
              )
            }}
          >
            Open lane
          </Button>
        )}
      </div>
      {!data.source.exists && (
        <p className="text-text-tertiary text-sm">The lane is no longer available.</p>
      )}
      {error && (
        <p role="status" className="text-danger text-sm">
          {error}
        </p>
      )}
    </div>
  )
}

/** Whether the lane changed after the read, when the sidebar knows; null when it does not. */
function useLaneGrew(sessionPath: string, finishedAt: number): boolean | null {
  return useSessionsStore((s) => {
    const meta = Object.values(s.disk)
      .flat()
      .find((entry) => entry.path === sessionPath)
    return meta ? Date.parse(meta.lastActivityAt) > finishedAt : null
  })
}

function ReadMemories({
  data,
  onMemory,
}: {
  data: BrainExtractionView
  onMemory: (id: string, label: string) => void
}): React.JSX.Element {
  if (!data.memories.length)
    return <p className="text-text-tertiary text-sm">No memory from this read is in Brain now.</p>
  return (
    <details>
      <TooltipSummary className="cursor-pointer">
        See these memories · {formatCount(data.memories.length, 'memory', 'memories')}
      </TooltipSummary>
      <ul className="border-border divide-border mt-2 divide-y rounded-md border">
        {data.memories.map((memory) => (
          <li key={memory.id}>
            <TooltipButton
              tooltip="Open in Knowledge"
              className="hover:bg-bg-secondary w-full px-3 py-2 text-left"
              onClick={() => onMemory(memory.id, memory.summary)}
            >
              {memory.summary}
            </TooltipButton>
          </li>
        ))}
      </ul>
    </details>
  )
}

/** Waiting reads are inspectable evidence, never a second manual decision surface. */
function WaitingRead({
  job,
  onInspect,
}: {
  job: BrainJob
  onInspect: () => void
}): React.JSX.Element {
  const never = useBrain((s) => brainLaneNeverRead(s.status!.prefs.neverRead, job))
  const load = useCallback(() => waitingProposal(job.id), [job.id])
  const { data: view, error, retry } = useBrainResource(load, true, job.state)
  const data = view?.proposal
  const refreshing = job.state === 'refreshing' || (view && !data)
  const questions = data
    ? data.identities.filter((identity) => !identity.auto).length + data.groups.length
    : null
  return (
    <article aria-label="Waiting read" className="min-w-0 space-y-4 p-4">
      <header>
        <h2 className="text-xl font-semibold">{brainLaneTitle(job.title)}</h2>
        <p className="text-text-tertiary text-sm">
          Waits for Defrag · {formatCount(job.memories, 'memory', 'memories')}
          {questions !== null && ` · ${formatCount(questions, 'question')}`}
          {job.finishedAt !== null && ` · read ${agoWords(Date.now() - job.finishedAt)}`}
        </p>
      </header>
      <p>
        {never
          ? 'Brain Agent will reject this read: Brain never reads this lane.'
          : 'Brain Agent reviews this read in the next Defrag.'}
      </p>
      {refreshing && (
        <p className="text-text-secondary">Refreshing: Brain changed since this lane was read.</p>
      )}
      {!data ? (
        refreshing ? null : (
          <p role="status">
            {error || 'Loading the read…'}{' '}
            {error && (
              <Button size="xs" onClick={retry}>
                Retry
              </Button>
            )}
          </p>
        )
      ) : (
        <ul className="space-y-4">
          {data.memories.map((memory) => (
            <li key={memory.index} className="space-y-2">
              <p>{memory.summary}</p>
              <MemoryQuotes quotes={memory.quotes} />
            </li>
          ))}
        </ul>
      )}
      <Button size="xs" onClick={onInspect}>
        See how it was read
      </Button>
    </article>
  )
}

/** Older runtimes report refresh progress as a refusal; it is not a failed load. */
async function waitingProposal(jobId: string): Promise<{ proposal: BrainProposalView | null }> {
  try {
    return { proposal: await window.phosphor.invoke('brain:proposal', jobId) }
  } catch (cause) {
    if (ipcErrorText(cause) === BRAIN_REVIEW_REFRESHING) return { proposal: null }
    throw cause
  }
}
