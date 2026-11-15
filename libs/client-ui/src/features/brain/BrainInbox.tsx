import clsx from 'clsx'
import type { BrainJob } from '@shared/brain'
import { TooltipButton } from '@/components/Tooltip'
import { PhosphorLoader } from '@/components/PhosphorLoader'
import { SectionLabel } from '@/features/sessions/SidebarPrimitives'
import { relativeTime } from '@/lib/time'
import { jobLine } from './jobProgress'
import { useBrainModelName } from './useBrainModelName'
import type { BrainLaneRow, groupBrainLanes } from './laneRows'
export { jobLine } from './jobProgress'

export function BrainInbox({
  groups,
  selected,
  onSelect,
  now,
  jobs,
}: {
  groups: ReturnType<typeof groupBrainLanes>
  selected: string | null
  onSelect: (id: string) => void
  now: number
  jobs: BrainJob[]
}): React.JSX.Element {
  return (
    <div className="space-y-4 p-3">
      {groups.map(({ label, rows }) => (
        <section key={label} aria-label={label}>
          <SectionLabel>
            {label} · {rows.length}
          </SectionLabel>
          <ul>
            {rows.map((row) => (
              <li key={row.job.id}>
                <LaneRow
                  row={row}
                  selected={selected === row.job.id}
                  onSelect={onSelect}
                  now={now}
                  ahead={
                    jobs
                      .slice(
                        0,
                        jobs.findIndex((job) => job.id === row.job.id),
                      )
                      .filter((job) => job.state === 'queued' || job.state === 'running').length
                  }
                />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}
function LaneRow({
  row: { job, memories },
  selected,
  onSelect,
  now,
  ahead,
}: {
  row: BrainLaneRow
  selected: boolean
  onSelect: (id: string) => void
  now: number
  ahead: number
}): React.JSX.Element {
  const model = useBrainModelName(job.model)
  const read = job.state === 'done' || job.state === 'empty'
  const line = read
    ? `${memories ? `${memories} memories` : 'Nothing kept'} · ${model} · ${job.finishedAt === null ? 'Finished' : relativeTime(job.finishedAt)}`
    : job.state === 'review'
      ? `${job.memories} memories · ${model}`
      : jobLine(job, ahead, now)
  return (
    <TooltipButton
      aria-label={job.title}
      tooltip={job.title}
      aria-current={selected ? 'true' : undefined}
      className={clsx(
        'hover:bg-bg-secondary flex w-full items-start gap-2 rounded-md px-2 py-2 text-left [overflow-wrap:anywhere]',
        selected && 'bg-sidebar-active',
        read && 'text-text-tertiary',
      )}
      onClick={() => onSelect(job.id)}
    >
      {job.state === 'running' && <PhosphorLoader size={16} label="Reading lane" />}
      <span className="min-w-0 flex-1">
        <span className="block font-medium">{job.title}</span>
        <span
          className={clsx('text-text-tertiary block text-sm', job.state === 'failed' && 'truncate')}
        >
          {line}
          {job.replaces && !read && ' · reading again'}
        </span>
      </span>
    </TooltipButton>
  )
}
