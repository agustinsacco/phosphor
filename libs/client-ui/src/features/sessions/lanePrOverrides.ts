import type { GhPrRef } from '@shared/models'

/**
 * Track or hide a pull request in one lane. The choice moves with the lane:
 * it is a `phosphor-prs` custom entry in the lane's own session file
 * (`LANE_PR_ENTRY` in `libs/session-runtime/src/pi/lane-pr-signals.ts`), which
 * the session scan folds back into `SessionMeta.pullRequests.pinned/hidden`.
 *
 * - `pin`: the PR belongs to the lane ("Track a PR…", or one click on a
 *   Reviewing or Mentioned suggestion).
 * - `hide`: the PR leaves the lane, whatever signal added it.
 * - `clear`: undo either.
 *
 * Only a live lane can write: the entry goes through the lane's own pi process,
 * the one writer of its file. Rejects with a message fit to show the user.
 */
export type LanePrOverride = 'pin' | 'hide' | 'clear'

export async function setLanePrOverride(
  sessionId: string,
  action: LanePrOverride,
  ref: GhPrRef,
): Promise<void> {
  void sessionId
  void action
  void ref
  throw new Error('Tracking pull requests is not available yet.')
}
