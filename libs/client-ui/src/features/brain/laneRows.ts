import type { BrainHistory, BrainJob } from '@shared/brain'

export interface BrainLaneRow {
  job: BrainJob
  memories: number
}
export function groupBrainLanes(
  jobs: BrainJob[],
  history: BrainHistory | null,
): { label: string; rows: BrainLaneRow[] }[] {
  const row = (job: BrainJob): BrainLaneRow => ({ job, memories: job.memories })
  const read = new Map((history?.items ?? []).map((item) => [item.job.id, item]))
  for (const job of jobs)
    if (job.state === 'empty') read.set(job.id, { job, memories: 0, replaceable: 0 })
  return [
    { label: 'To review', rows: jobs.filter((job) => job.state === 'review').map(row) },
    {
      label: 'Reading',
      rows: ['running', 'queued', 'waiting'].flatMap((state) =>
        jobs.filter((job) => job.state === state).map(row),
      ),
    },
    { label: 'Failed', rows: jobs.filter((job) => job.state === 'failed').map(row) },
    {
      label: 'Read',
      rows: [...read.values()].sort((a, b) => (b.job.finishedAt ?? 0) - (a.job.finishedAt ?? 0)),
    },
  ].filter((group) => group.rows.length)
}
export function selectBrainLane(
  selected: string | null,
  groups: ReturnType<typeof groupBrainLanes>,
): string | null {
  if (groups.some((group) => group.rows.some(({ job }) => job.id === selected))) return selected
  for (const label of ['To review', 'Reading', 'Read', 'Failed']) {
    const first = groups.find((group) => group.label === label)?.rows[0]
    if (first) return first.job.id
  }
  return null
}
