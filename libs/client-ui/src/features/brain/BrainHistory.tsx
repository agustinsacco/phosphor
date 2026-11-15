import { Button } from '@/components/form'
import { TooltipButton } from '@/components/Tooltip'
import { SectionLabel } from '@/features/sessions/SidebarPrimitives'
import { relativeTime } from '@/lib/time'
import { useBrain } from './useBrain'
import { useBrainResource } from './useBrainResource'
import { BrainReadAgain } from './BrainReadAgain'

const loadHistory = () => window.phosphor.invoke('brain:history', 200)

export function BrainHistory({
  onExtraction,
}: {
  onExtraction: (id: string) => void
}): React.JSX.Element | null {
  const inbox = useBrain((s) => JSON.stringify(s.status?.jobs))
  // Inbox changes include completed reads with no knowledge/revision change.
  const { data, error, retry } = useBrainResource(loadHistory, true, inbox)
  if (error)
    return (
      <div role="status" className="p-3">
        {error} <Button onClick={retry}>Retry</Button>
      </div>
    )
  if (!data?.items.length) return null
  return (
    <section aria-label="Read lanes" className="space-y-1 p-3">
      <SectionLabel>Read lanes</SectionLabel>
      {data.items.map(({ job, memories, replaceable }) => (
        <article
          key={job.id}
          className="text-text-tertiary border-border flex items-center gap-2 border-b py-3"
        >
          <TooltipButton
            className="min-w-0 flex-1 text-left"
            tooltip={`View extraction of ${job.title}`}
            onClick={() => onExtraction(job.id)}
          >
            <span className="block truncate font-medium">{job.title}</span>
            <span className="text-sm">
              {job.model} · {job.finishedAt === null ? 'Finished' : relativeTime(job.finishedAt)} ·{' '}
              {memories} memories
            </span>
          </TooltipButton>
          <BrainReadAgain job={job} memories={memories} replaceable={replaceable} />
        </article>
      ))}
      {data.more && <p className="text-text-tertiary text-sm">Showing the newest 200 reads.</p>}
    </section>
  )
}
