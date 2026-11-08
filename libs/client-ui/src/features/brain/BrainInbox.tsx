import { useEffect, useState } from 'react'
import type { BrainJob } from '@shared/brain'
import { Button } from '@/components/form'
import { PhosphorLoader } from '@/components/PhosphorLoader'
import { elapsedTime } from './BrainReview'
import { useBrain } from './useBrain'

function jobLine(job: BrainJob, ahead: number, now: number): string {
  switch (job.state) {
    case 'waiting':
      return 'Waits until the lane is idle'
    case 'queued':
      return ahead ? `Queued · ${ahead} ahead` : 'Queued · starting'
    case 'running':
      return `Reading a private copy · ${elapsedTime(now - (job.startedAt ?? now))}`
    case 'review':
      return `${job.memories} memories to review`
    case 'empty':
      return 'Nothing new worth keeping'
    case 'failed':
      return job.error ?? 'Knowledge extraction failed'
    case 'done':
      return ''
  }
}

export function BrainInbox({
  jobs,
  onReview,
}: {
  jobs: BrainJob[]
  onReview: (id: string) => void
}): React.JSX.Element {
  const [now, setNow] = useState(Date.now())
  const running = jobs.some((job) => job.state === 'running')
  const saving = useBrain((s) => s.saving)
  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [running])
  return (
    <section aria-label="Inbox" className="space-y-1 p-3">
      <h2 className="text-text-tertiary mb-2 text-sm font-medium">Inbox</h2>
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
