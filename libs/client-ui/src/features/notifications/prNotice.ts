import type { GhPrKey, GhPrRef, GhPrSummary } from '@shared/models'
import type { NativeNotice } from '@shared/notifications'
import type { Toast } from '@/stores/extensionUi'
import type { PrChange, PrChangeTone } from '@/features/sessions/prChanges'
import type { PrHandoff } from '@/features/sessions/prHandoff'
import { prVerdict } from '@/features/sessions/prVerdict'

/**
 * Where a PR's lane lives: a This Mac session file and the folder it is listed
 * under, or a Host lane by its ids (never a path on the Host). Spelled here, not
 * in `prLaneIndex.ts`, so the stores that hold notices import no lane stores.
 */
export type PrLanePlace =
  { path: string; workspacePath: string } | { hostId: string; laneId: string }

/**
 * A pull request's change notice: what moved on one PR a lane owns, on This
 * Mac or a Host. The drawer row, the toast and the native notification all
 * word it from here, so the three say the same thing.
 */
export interface PrNotice {
  key: GhPrKey
  ref: GhPrRef
  /** The lane that owns it: a This Mac session file, or a Host lane by id. */
  lane: PrLanePlace & { title: string }
  /** The read that raised (or last replaced) the notice. */
  summary: GhPrSummary
  /** Every change since the user last looked at this notice, newest first. */
  changes: PrChange[]
}

/** One notice per PR: a newer change replaces the older one. */
export const prNoticeKey = (key: GhPrKey): string => `pr:${key}`

/** "#57 Rocky review failed (not required)": the PR and its newest, most important change. */
export function prNoticeTitle(notice: Pick<PrNotice, 'ref' | 'changes'>): string {
  const lead = notice.changes[0]
  return `#${notice.ref.number}${lead ? ` ${lead.text}` : ''}`
}

/** "Refactor auth module · Phosphor#57": the lane, then where the PR lives. */
export function prNoticePlace(notice: Pick<PrNotice, 'ref' | 'lane'>): string {
  return `${notice.lane.title} · ${notice.ref.repo}#${notice.ref.number}`
}

/**
 * The native notification. A This Mac lane's names the repository; a Host lane's
 * names its machine instead, since the shared rule (`attentionNotice`) keeps
 * repository names off lock screens. A Host lane's also carries its stable key
 * and route, so the browser's worker replaces it and opens the lane on this PR.
 */
export function prNativeNotice(
  notice: PrNotice,
  machineLabel: (hostId: string) => string,
): NativeNotice {
  const title = prNoticeTitle(notice)
  const { lane } = notice
  if (!('hostId' in lane)) return { title, body: `${lane.title} · ${notice.ref.repo}` }
  return {
    title,
    body: `${machineLabel(lane.hostId)} · ${lane.title}`,
    key: prNoticeKey(notice.key),
    route: { hostId: lane.hostId, laneId: lane.laneId, pr: notice.ref },
  }
}

const KIND: Record<PrChangeTone, Toast['kind']> = {
  bad: 'error',
  warn: 'warning',
  good: 'success',
  info: 'info',
  merged: 'info',
}

/** The card's kind follows the change it leads with (its timing and its role). */
export function prNoticeKind(notice: Pick<PrNotice, 'changes'>): Toast['kind'] {
  return KIND[notice.changes[0]?.tone ?? 'info']
}

/**
 * Newer changes first, then the earlier ones still unseen. A change that
 * happened again (red, green, red) is listed once, at its newest place.
 */
export function mergeSince(fresh: readonly PrChange[], earlier: readonly PrChange[]): PrChange[] {
  const texts = new Set(fresh.map((change) => change.text))
  return [...fresh, ...earlier.filter((change) => !texts.has(change.text))]
}

export type PrNoticeAction =
  { kind: 'handoff'; handoff: PrHandoff; label: string } | { kind: 'github'; label: string }

/**
 * The one action a notice offers beside Open lane, from what the PR needs now:
 * red checks, requested changes or a conflict go to the lane's agent as a
 * draft; a PR ready to merge opens on GitHub. Merged and everything else: none.
 */
export function prNoticeAction(summary: GhPrSummary): PrNoticeAction | null {
  switch (prVerdict(summary).tone) {
    case 'failing':
      return { kind: 'handoff', handoff: 'fix-checks', label: 'Ask agent to fix' }
    case 'blocked':
      return { kind: 'handoff', handoff: 'address-changes', label: 'Ask agent to address' }
    case 'conflict':
      return { kind: 'handoff', handoff: 'update-branch', label: 'Ask agent to update' }
    case 'ready':
      return { kind: 'github', label: 'Open on GitHub' }
    default:
      return null
  }
}
