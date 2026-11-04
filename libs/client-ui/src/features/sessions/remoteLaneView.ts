import type { HostLaneView } from '@shared/ipc'
import { laneMarker } from '@/lib/laneMarker'
import { sessionTitle } from '@/lib/sessionTitle'
import { relativeTimeShort } from '@/lib/time'
import type { SubtitleSegment } from './sessionSubtitle'

export function remoteLaneTitle(
  name?: string | null,
  summary?: string | null,
  first?: string,
): string {
  return (
    sessionTitle({ explicitName: name?.trim() || summary, firstUserText: first }) ?? 'Untitled lane'
  )
}

/** A Host lane's marker by This Mac's rule: its explicit choice, else derived from its branch or folder. */
export function remoteLaneMarker(
  lane: Pick<HostLaneView, 'marker' | 'branch' | 'cwd'>,
  mode: Parameters<typeof laneMarker>[3],
): string {
  return laneMarker(lane.marker, lane.branch, lane.cwd, mode)
}

/** Process lifecycle is not an agent result; unread attention is not a request for input. */
export function remoteLanePresentation(lane: HostLaneView, ready: boolean) {
  const working = ready && lane.activity === 'working'
  const running = lane.activity !== 'stopped' && lane.activity !== 'failed'
  const indicator = working
    ? 'streaming'
    : lane.attention > lane.read
      ? 'unseen'
      : ready && running
        ? 'live'
        : 'disk'
  const segments: SubtitleSegment[] = [
    { key: 'time', text: relativeTimeShort(Date.parse(lane.updatedAt)) },
    ...(lane.worktree ? [{ key: 'worktree' as const, text: 'wt' }] : []),
    ...(lane.branch ? [{ key: 'branch' as const, text: lane.branch, truncate: true }] : []),
  ]
  return {
    indicator,
    segments,
    activity: working ? ('working' as const) : undefined,
    needsYou: lane.activity === 'failed' || lane.activity === 'needs-input',
  } as const
}
