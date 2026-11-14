import type { GhPrDetail, GhPrEvent, GhPrSummary } from '@shared/models'

/** One timeline line in words, and the tone it reads in. */
export type ActivityTone = 'good' | 'bad' | 'warn' | 'merged' | 'plain'

export interface ActivityLine {
  text: string
  tone: ActivityTone
}

const who = (actor?: string) => (actor ? `@${actor}` : 'Someone')

export function activityLine(event: GhPrEvent): ActivityLine {
  const actor = who(event.actor)
  switch (event.kind) {
    case 'review':
      if (event.state === 'APPROVED') return { text: `${actor} approved`, tone: 'good' }
      if (event.state === 'CHANGES_REQUESTED')
        return { text: `${actor} requested changes`, tone: 'warn' }
      if (event.state === 'DISMISSED')
        return { text: `${actor}’s review was dismissed`, tone: 'plain' }
      return { text: `${actor} commented`, tone: 'plain' }
    case 'commit':
      return { text: `${actor} pushed${event.text ? `: ${event.text}` : ''}`, tone: 'plain' }
    case 'force-push':
      return { text: `${actor} force-pushed`, tone: 'plain' }
    case 'requested':
      return {
        text: event.text
          ? `${actor} asked @${event.text} to review`
          : `${actor} asked for a review`,
        tone: 'plain',
      }
    case 'ready':
      return { text: `${actor} marked it ready for review`, tone: 'plain' }
    case 'merged':
      return { text: `${actor} merged it`, tone: 'merged' }
    case 'closed':
      return { text: `${actor} closed it`, tone: 'bad' }
    case 'reopened':
      return { text: `${actor} reopened it`, tone: 'plain' }
  }
}

/** Newest first. */
export function newestFirst(activity: GhPrEvent[]): GhPrEvent[] {
  return [...activity].sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
}

/** Who merged it and when, when the timeline says. */
export function mergedBy(
  summary: GhPrSummary,
  detail?: GhPrDetail,
): { at?: string; actor?: string } {
  const event = detail?.activity.findLast((e) => e.kind === 'merged')
  return { at: summary.mergedAt ?? event?.at, actor: event?.actor }
}

/** `KI` for kim, `CR` for core-reviewers: never a remote image. */
export function initials(name: string): string {
  const parts = name.split(/[^a-z0-9]+/i).filter(Boolean)
  const letters =
    parts.length > 1 ? `${parts[0]![0]}${parts[1]![0]}` : (parts[0] ?? '?').slice(0, 2)
  return letters.toUpperCase()
}

/** `Nov 13, 04:06`: the absolute time beside a relative one. */
export function eventTime(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}
