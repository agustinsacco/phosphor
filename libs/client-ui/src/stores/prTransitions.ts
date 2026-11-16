import type { GhPrKey, GhPrSummary } from '@shared/models'
import { prChanges, type PrChange } from '@/features/sessions/prChanges'
import { currentPrLaneIndex, type PrLaneOwner } from '@/features/sessions/prLaneIndex'
import {
  mergeSince,
  prNativeNotice,
  prNoticeKey,
  prNoticeKind,
  prNoticePlace,
  prNoticeTitle,
  type PrNotice,
} from '@/features/notifications/prNotice'
import { openPrNotice } from '@/features/notifications/prNoticeActions'
import { acknowledgeToast, useExtensionUiStore } from './extensionUi'
import { useLanePrefsStore } from './lanePrefs'
import { useNotificationsStore } from './notifications'
import { usePrStatusStore, type PrStatusEntry } from './prStatus'
import { machineLabel } from './remoteLanes'

/**
 * PR change notices. Watches PR status (`stores/prStatus.ts`) and, when a PR
 * a lane owns (This Mac's or a Host's) changes in a way worth interrupting
 * for, says so on the toast, in the drawer and, while Phosphor is in the
 * background, as a native notification. Desktop and the browser shell each
 * attach it once.
 *
 * The first answer for a PR after launch is only a baseline: nothing on
 * launch. A read that did not answer (failed, or GitHub unavailable) says
 * nothing and moves no baseline. Every answer moves it, even with the PR
 * status preference off or for a PR no lane owns, so turning either on later
 * never replays old news.
 */
export interface PrTransition {
  key: GhPrKey
  summary: GhPrSummary
  /** The important changes, most important first. */
  changes: PrChange[]
}

/** What a read answered. Stale and failed reads answered nothing. */
function answered(entry: PrStatusEntry | undefined): GhPrSummary | undefined {
  if (!entry?.summary || entry.failed || entry.coverage?.state === 'unavailable') return undefined
  return entry.summary
}

/**
 * A read GitHub answered without checks (too costly or slow) keeps the last
 * known checks, so the next full read is compared with real ones, not nothing.
 */
function withKnownChecks(summary: GhPrSummary, before: GhPrSummary | undefined): GhPrSummary {
  if (summary.checkRuns || summary.checks || !before) return summary
  return {
    ...summary,
    checkRuns: before.checkRuns,
    checks: before.checks,
    checksTruncated: before.checksTruncated,
  }
}

/** Each PR just read, against its last answer. Moves the baselines it reads. */
export function readPrTransitions(
  baselines: Map<GhPrKey, GhPrSummary>,
  next: Readonly<Record<GhPrKey, PrStatusEntry>>,
  previous: Readonly<Record<GhPrKey, PrStatusEntry>>,
): PrTransition[] {
  const out: PrTransition[] = []
  for (const [key, entry] of Object.entries(next)) {
    if (entry === previous[key]) continue
    const summary = answered(entry)
    if (!summary) continue
    const before = baselines.get(key)
    baselines.set(key, withKnownChecks(summary, before))
    if (!before || before === summary) continue
    const changes = prChanges(before, summary).filter((change) => change.important)
    if (changes.length) out.push({ key, summary, changes })
  }
  return out
}

/**
 * One notice per PR (`pr:<prKey>`). A newer change replaces the older notice,
 * keeping its changes in "since you looked" until the user opens or
 * dismisses it (then it is seen, and the next notice starts over).
 */
export function raisePrNotice(transition: PrTransition, owner: PrLaneOwner): PrNotice {
  const key = prNoticeKey(transition.key)
  const earlier = useNotificationsStore
    .getState()
    .items.find((item) => item.key === key && !item.seenAt)?.pr?.changes
  const { pr: _pr, sessionId: _sessionId, ...lane } = owner
  const notice: PrNotice = {
    key: transition.key,
    ref: owner.pr.ref ?? transition.summary.ref,
    lane,
    summary: transition.summary,
    changes: mergeSince(transition.changes, earlier ?? []),
  }
  useExtensionUiStore.getState().notify({
    key,
    pr: notice,
    kind: prNoticeKind(notice),
    title: prNoticeTitle(notice),
    message: prNoticePlace(notice),
    openLabel: 'Open lane',
    onOpen: () => openPrNotice(notice),
  })
  notifyNatively(notice)
  return notice
}

/**
 * The native notification, only while Phosphor is not the focused app: in
 * front of the user the toast already says it, and two would be one too many.
 * On Desktop, clicking it brings the window forward (main), opens the lane on
 * this PR and counts as looking. The browser resolves false at once; its worker
 * opens the notice's route instead.
 */
export function notifyNatively(notice: PrNotice, focused = document.hasFocus()): void {
  if (focused) return
  const key = prNoticeKey(notice.key)
  window.phosphor
    .invoke('app:notify', prNativeNotice(notice, machineLabel))
    .then((clicked) => {
      if (!clicked) return
      for (const toast of useExtensionUiStore.getState().toasts)
        if (toast.key === key) acknowledgeToast(toast)
      const inbox = useNotificationsStore.getState()
      inbox.markSeen(inbox.items.filter((item) => item.key === key).map((item) => item.id))
      return openPrNotice(notice)
    })
    // Native delivery is optional; the toast and the drawer still have it.
    .catch(() => undefined)
}

/** Start watching. Whatever status is already known is the baseline. Returns the stop. */
export function attachPrTransitions(): () => void {
  const baselines = new Map<GhPrKey, GhPrSummary>()
  readPrTransitions(baselines, usePrStatusStore.getState().byKey, {})
  return usePrStatusStore.subscribe((state, previous) => {
    if (state.byKey === previous.byKey) return
    const transitions = readPrTransitions(baselines, state.byKey, previous.byKey)
    if (!transitions.length || !useLanePrefsStore.getState().lanes.prStatus) return
    const owners = currentPrLaneIndex()
    for (const transition of transitions) {
      const owner = owners.get(transition.key)
      if (owner) raisePrNotice(transition, owner)
    }
  })
}
