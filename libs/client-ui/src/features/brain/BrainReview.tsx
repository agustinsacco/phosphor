import { useCallback, useState } from 'react'
import { BRAIN_MEMORY_TYPES, type BrainProposalView, type BrainMemoryDetail } from '@shared/brain'
import { Button } from '@/components/form'
import { TooltipSummary } from '@/components/Tooltip'
import { basename } from '@/lib/path'
import { useBrain } from './useBrain'
import { useBrainResource } from './useBrainResource'
import { MEMORY_LABELS, MemoryQuotes, MemoryTags } from './BrainMemory'

export function elapsedTime(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

export function BrainReview({
  jobId,
  onClose,
}: {
  jobId: string
  onClose: () => void
}): React.JSX.Element {
  const load = useCallback(() => window.phosphor.invoke('brain:proposal', jobId), [jobId])
  const { data, error, retry } = useBrainResource(load)
  if (!data)
    return (
      <div className="p-4" role="status">
        {error || 'Loading review…'}
        {error && <Button onClick={retry}>Retry</Button>}
        <Button onClick={onClose}>Back to graph</Button>
      </div>
    )
  return <ReviewProposal key={`${jobId}:${data.revision}`} proposal={data} onClose={onClose} />
}

function ReviewProposal({
  proposal,
  onClose,
}: {
  proposal: BrainProposalView
  onClose: () => void
}): React.JSX.Element {
  const [keep, setKeep] = useState(() => proposal.memories.map((_, index) => index))
  const saving = useBrain((s) => s.saving)
  const { job, memories } = proposal
  const review = (indexes: number[] | null): void => {
    void useBrain
      .getState()
      .review(job.id, indexes, proposal.revision)
      .then((ok) => {
        if (ok) onClose()
      })
  }
  return (
    <section aria-label="Review memories" className="space-y-4 p-4">
      <Button size="sm" onClick={onClose}>
        Back to graph
      </Button>
      <header>
        <h2 className="text-xl font-semibold">{job.title}</h2>
        <p className="text-text-tertiary mt-1 text-sm">
          {basename(job.scope)} · read by {job.model} in{' '}
          {elapsedTime((job.finishedAt ?? Date.now()) - (job.startedAt ?? job.queuedAt))}
        </p>
      </header>
      <p>{proposal.summary}</p>
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" disabled={saving || !keep.length} onClick={() => review(keep)}>
          Approve {keep.length}
        </Button>
        <Button disabled={saving} onClick={() => review(null)}>
          Reject all
        </Button>
        <Button
          disabled={saving}
          onClick={() => setKeep(keep.length === memories.length ? [] : memories.map((_, i) => i))}
        >
          {keep.length === memories.length ? 'Uncheck all' : 'Check all'}
        </Button>
      </div>
      <p className="text-text-tertiary text-sm">Nothing is searchable until you approve it.</p>
      <ProposalMemories
        memories={memories}
        keep={keep}
        saving={saving}
        onToggle={(index, checked) =>
          setKeep((previous) =>
            checked
              ? [...previous, index].sort((a, b) => a - b)
              : previous.filter((i) => i !== index),
          )
        }
      />
    </section>
  )
}

function ProposalMemories({
  memories,
  keep,
  saving,
  onToggle,
}: {
  memories: BrainMemoryDetail[]
  keep: number[]
  saving: boolean
  onToggle: (index: number, checked: boolean) => void
}): React.JSX.Element {
  return (
    <>
      {BRAIN_MEMORY_TYPES.map((type) => {
        const group = memories
          .map((detail, index) => ({ ...detail, index }))
          .filter((item) => item.memory.type === type)
        return (
          group.length > 0 && (
            <section key={type} className="space-y-3">
              <h3 className="text-text-secondary text-sm font-medium">
                {MEMORY_LABELS[type]} · {group.length}
              </h3>
              {group.map(({ memory, quotes, index }) => (
                <article key={index} className="border-border space-y-2 rounded-lg border p-3">
                  <label className="flex items-start gap-3">
                    <input
                      className="mt-1"
                      type="checkbox"
                      checked={keep.includes(index)}
                      disabled={saving}
                      onChange={(event) => onToggle(index, event.target.checked)}
                    />
                    <span>{memory.summary}</span>
                  </label>
                  <MemoryTags memory={memory} />
                  <details>
                    <TooltipSummary className="text-text-tertiary cursor-pointer text-sm">
                      {quotes.length} quotes
                    </TooltipSummary>
                    <div className="mt-2">
                      <MemoryQuotes quotes={quotes} />
                    </div>
                  </details>
                </article>
              ))}
            </section>
          )
        )
      })}
    </>
  )
}
