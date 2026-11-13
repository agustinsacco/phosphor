import { useEffect, useState } from 'react'
import type { BrainJob } from '@shared/brain'
import { Button } from '@/components/form'
import { PhosphorLoader } from '@/components/PhosphorLoader'
import { jobLine } from './jobProgress'
export { jobLine } from './jobProgress'
import { useBrain } from './useBrain'
import { SectionLabel } from '@/features/sessions/SidebarPrimitives'

export function BrainInbox({
  jobs,
  onReview,
  onExtraction,
}: {
  jobs: BrainJob[]
  onReview: (id: string) => void
  onExtraction: (id: string) => void
}): React.JSX.Element | null {
  const [now, setNow] = useState(Date.now())
  const running = jobs.some((job) => job.state === 'running')
  const saving = useBrain((s) => s.saving)
  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [running])
  if (!jobs.length) return null
  return (
    <section aria-label="Inbox" className="space-y-1 p-3">
      <SectionLabel>Inbox</SectionLabel>
      {jobs.map((job, index) => (
        <article key={job.id} className="border-border flex items-start gap-2 border-b py-3">
          {job.state === 'running' ? (
            <PhosphorLoader size={16} label="Extracting knowledge" />
          ) : (
            <span className="bg-text-tertiary mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full" />
          )}
          <div className="min-w-0 flex-1">
            <h3 className="truncate font-medium">{job.title}</h3>
            <p className="text-text-tertiary mt-1 text-sm">
              {jobLine(
                job,
                jobs.slice(0, index).filter((j) => j.state === 'queued' || j.state === 'running')
                  .length,
                now,
              )}
            </p>
          </div>
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
          {(job.state === 'empty' || job.state === 'failed') && (
            <Button size="xs" onClick={() => onExtraction(job.id)}>
              View extraction
            </Button>
          )}
          <Button
            size="xs"
            disabled={saving}
            variant={job.state === 'review' ? 'primary' : 'secondary'}
            onClick={() => {
              if (job.state === 'review') onReview(job.id)
              else void useBrain.getState().cancel(job.id)
            }}
          >
            {job.state === 'review'
              ? 'Review'
              : job.state === 'failed' || job.state === 'empty'
                ? 'Dismiss'
                : 'Cancel'}
          </Button>
        </article>
      ))}
    </section>
  )
}
