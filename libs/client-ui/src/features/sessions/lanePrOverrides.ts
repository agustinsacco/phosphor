import { isPrRef, prUrl } from '@shared/github-pr-refs'
import type { GhPrRef } from '@shared/models'
import { piCall, piCallOk } from '@/lib/rpc'
import { useChatStore } from '@/stores/chat'
import { useLanePrOverridesStore } from '@/stores/lanePrOverrides'
import { useSessionsStore } from '@/stores/sessions'

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

/**
 * `LANE_PRS_COMMAND` in `libs/pi-extensions/pi-ext/lane-prs.ts`. Spelled here
 * because the Web image ships only the extension helpers it lists; the test
 * pins the two together.
 */
export const LANE_PRS_COMMAND = 'phosphor-prs'

const chatError = (sessionId: string, fallback: string): string =>
  useChatStore.getState().sessions[sessionId]?.error ?? fallback

/** The lane's session file, or why this lane cannot write one. */
function writablePath(sessionId: string): string {
  const live = useSessionsStore.getState().live[sessionId]
  if (live?.target?.kind === 'remote')
    throw new Error('Tracking pull requests is not available on Host lanes yet.')
  if (!live?.diskPath) throw new Error('Open the lane to track pull requests.')
  return live.diskPath
}

export async function setLanePrOverride(
  sessionId: string,
  action: LanePrOverride,
  ref: GhPrRef,
): Promise<void> {
  if (!isPrRef(ref)) throw new Error('That is not a pull request link.')
  const path = writablePath(sessionId)
  // Check registration first: an unknown slash command would run a model instead.
  const commands = await piCall(sessionId, { type: 'get_commands' })
  if (!commands) throw new Error(chatError(sessionId, 'Could not reach this lane.'))
  if (!commands.commands.some((c) => c.name === LANE_PRS_COMMAND && c.source === 'extension'))
    throw new Error("This lane's pi doesn't support tracking yet. Restart the lane to update it.")
  // pi runs an extension command at once, even mid-turn, and answers `handled`.
  const sent = await piCallOk(sessionId, {
    type: 'prompt',
    message: `/${LANE_PRS_COMMAND} ${action} ${prUrl(ref)}`,
  })
  if (!sent) throw new Error(chatError(sessionId, 'Could not update the lane.'))
  useLanePrOverridesStore.getState().record(path, action, ref)
  // Main counts any prompt as unsettled work until a state read says otherwise;
  // without this, quitting after a Track would warn about unfinished work.
  await piCall(sessionId, { type: 'get_state' })
}
