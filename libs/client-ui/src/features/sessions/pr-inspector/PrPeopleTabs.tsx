import clsx from 'clsx'
import type { GhPrDetail, GhPrSummary, GhPrThread } from '@shared/models'
import { tooltipProps } from '@/components/Tooltip'
import { activityLine, eventTime, newestFirst, type ActivityTone } from './prActivity'
import { agoText } from './prFreshness'
import { ActionButton, Avatar, LinkButton, SkeletonRows, Tag } from './PrBits'
import { useNow } from './PrHeader'

interface Person {
  name: string
  ring: 'ok' | 'warn' | 'plain'
  team: boolean
  status: string
  statusClass: string
  owner?: boolean
}

/** Approved, requested changes, commented, then still waiting. */
export function reviewPeople(summary: GhPrSummary, detail?: GhPrDetail): Person[] {
  const decided = new Set([...summary.approvedBy, ...summary.changesRequestedBy])
  return [
    ...summary.approvedBy.map((name) => ({
      name,
      ring: 'ok' as const,
      team: false,
      status: 'approved',
      statusClass: 'text-success',
    })),
    ...summary.changesRequestedBy.map((name) => ({
      name,
      ring: 'warn' as const,
      team: false,
      status: 'requested changes',
      statusClass: 'text-warning',
    })),
    ...(detail?.commented ?? [])
      .filter((name) => !decided.has(name))
      .map((name) => ({
        name,
        ring: 'plain' as const,
        team: false,
        status: 'commented',
        statusClass: 'text-text-secondary',
      })),
    ...summary.waitingOn.map((r) => ({
      name: r.name,
      ring: 'plain' as const,
      team: r.team,
      owner: r.codeOwner,
      status: 'waiting',
      statusClass: 'text-text-secondary',
    })),
  ]
}

export function PrPeople({
  summary,
  detail,
  wrap = false,
}: {
  summary: GhPrSummary
  detail?: GhPrDetail
  wrap?: boolean
}): React.JSX.Element {
  const people = reviewPeople(summary, detail)
  if (!people.length) return <p className="text-text-secondary text-base">No reviewers yet.</p>
  return (
    <ul className={clsx(wrap ? 'flex flex-wrap gap-x-3 gap-y-1' : 'space-y-1.5')}>
      {people.map((person) => (
        <li
          key={`${person.status}:${person.name}`}
          className="flex min-w-0 items-center gap-1.5 text-base"
        >
          <Avatar name={person.name} ring={person.ring} team={person.team} />
          <span className="min-w-0 truncate">@{person.name}</span>
          {person.owner && <Tag>code owner</Tag>}
          <span className={person.statusClass}>{person.status}</span>
        </li>
      ))}
    </ul>
  )
}

export function PrThreadsTab({
  summary,
  detail,
  loading,
  limit,
  onOpen,
  onAddress,
}: {
  summary: GhPrSummary | undefined
  detail: GhPrDetail | undefined
  loading: boolean
  limit?: number
  onOpen: (url: string) => void
  onAddress?: () => void
}): React.JSX.Element {
  if (!detail)
    return loading ? (
      <SkeletonRows rows={4} />
    ) : (
      <p className="text-text-secondary text-base">
        Threads are not available for this pull request.
      </p>
    )
  const threads = detail.threads.slice(0, limit)
  const unresolved = summary?.threads?.unresolved ?? detail.threads.length
  const more = Math.max(unresolved - threads.length, detail.threadsTruncated ? 1 : 0)
  if (!threads.length)
    return <p className="text-text-secondary text-base">No unresolved threads.</p>
  return (
    <div>
      {onAddress && (
        <div className="mb-2 flex">
          <ActionButton
            primary
            onClick={onAddress}
            tooltip="Draft a message asking the agent to address these threads"
          >
            Address threads
          </ActionButton>
        </div>
      )}
      <ul className="space-y-2">
        {threads.map((thread, i) => (
          <ThreadRow key={`${thread.path}:${thread.line}:${i}`} thread={thread} onOpen={onOpen} />
        ))}
      </ul>
      {more > 0 && (
        <p className="text-text-secondary mt-2 text-sm">
          {detail.threadsTruncated && more === 1 ? 'More' : `+${more} more`} on GitHub
        </p>
      )}
    </div>
  )
}

function ThreadRow({
  thread,
  onOpen,
}: {
  thread: GhPrThread
  onOpen: (url: string) => void
}): React.JSX.Element {
  return (
    <li data-testid="pr-thread" className="text-base">
      <div className="flex min-w-0 items-center gap-1.5">
        <span
          className="text-text-secondary min-w-0 truncate font-mono text-sm"
          {...tooltipProps(thread.path)}
        >
          {thread.path}
          {thread.line ? `:${thread.line}` : ''}
        </span>
        {thread.author && (
          <span className="text-text-tertiary shrink-0 text-sm">@{thread.author}</span>
        )}
        {thread.outdated && <Tag>outdated</Tag>}
        <span className="flex-1" />
        {thread.replies > 0 && (
          <span className="text-text-tertiary shrink-0 text-sm">
            {thread.replies} {thread.replies === 1 ? 'reply' : 'replies'}
          </span>
        )}
        {thread.url && (
          <LinkButton
            onClick={() => onOpen(thread.url!)}
            label={`Open the thread on ${thread.path} on GitHub`}
          >
            open ↗
          </LinkButton>
        )}
      </div>
      <p className="pr-clamp-2 mt-0.5 leading-snug" {...tooltipProps(thread.body)}>
        {thread.body}
      </p>
    </li>
  )
}

const TONE: Record<ActivityTone, string> = {
  good: 'text-success',
  bad: 'text-danger',
  warn: 'text-warning',
  merged: 'text-merged',
  plain: 'text-text',
}

export function PrActivityTab({
  detail,
  loading,
  seenAt,
}: {
  detail: GhPrDetail | undefined
  loading: boolean
  seenAt?: number
}): React.JSX.Element {
  const now = useNow(30_000)
  if (!detail)
    return loading ? (
      <SkeletonRows rows={5} />
    ) : (
      <p className="text-text-secondary text-base">
        Activity is not available for this pull request.
      </p>
    )
  if (!detail.activity.length)
    return <p className="text-text-secondary text-base">No recent activity.</p>
  return (
    <>
      <ol className="space-y-0.5">
        {newestFirst(detail.activity).map((event, i) => {
          const at = Date.parse(event.at)
          const fresh = seenAt !== undefined && at > seenAt
          const line = activityLine(event)
          return (
            <li
              key={`${event.at}:${i}`}
              data-new={fresh || undefined}
              className={clsx(
                '-mx-1.5 flex items-baseline gap-2 rounded-md px-1.5 py-1 text-base',
                fresh && 'from-accent-soft bg-gradient-to-r to-transparent',
              )}
            >
              <span className="w-28 shrink-0 leading-tight">
                <span className="text-text-secondary block text-sm">{agoText(at, now)}</span>
                <span className="text-text-tertiary block text-sm">{eventTime(at)}</span>
              </span>
              <span className={clsx('min-w-0 flex-1', TONE[line.tone])}>
                {line.text}
                {fresh && <span className="sr-only"> (new since you looked)</span>}
              </span>
            </li>
          )
        })}
      </ol>
      {seenAt !== undefined && (
        <p className="text-text-tertiary mt-2 text-sm">Highlighted: new since you last looked.</p>
      )}
    </>
  )
}
