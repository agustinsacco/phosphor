import { isPrRef, prUrl } from '@shared/github-pr-refs'
import type { GhPrRef } from '@shared/models'
import { remoteLaneKey } from '@shared/remote-host'
import { piCall, piCallOk } from '@/lib/rpc'
import { laneControlHint } from '@/features/machines/useLaneControl'
import { useChatStore } from '@/stores/chat'
import { useLanePrOverridesStore } from '@/stores/lanePrOverrides'
import { sessionHostLane } from '@/stores/remoteLanes'
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
 * the one writer of its file. A Host lane's pi is on its Host, so this window
 * must hold the lane, and the lane must be running: a prompt to a stopped Host
 * lane would resume it. Rejects with a message fit to show the user.
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

export const OPEN_TO_TRACK = 'Open the lane to track pull requests.'
export const RESUME_TO_TRACK = 'Resume the lane to track pull requests.'
/** A Host without `prStatus` folds no PR signals: a write there would never show. */
export const HOST_TRACK_NEEDS_UPDATE = 'Update this Host to track pull requests.'

/** The override store's key for the lane, or why this lane cannot write now. */
function writableLane(sessionId: string): string {
  const live = useSessionsStore.getState().live[sessionId]
  if (live?.target?.kind !== 'remote') {
    if (!live?.diskPath) throw new Error(OPEN_TO_TRACK)
    return live.diskPath
  }
  const remote = sessionHostLane(sessionId)
  if (!remote?.laneId || !remote.lane) throw new Error(OPEN_TO_TRACK)
  const hint = laneControlHint(remote)
  if (hint) throw new Error(hint)
  if (remote.host?.prStatus !== true) throw new Error(HOST_TRACK_NEEDS_UPDATE)
  if (remote.lane.activity === 'stopped' || remote.lane.activity === 'failed')
    throw new Error(RESUME_TO_TRACK)
  return remoteLaneKey(remote.hostId, remote.laneId)
}

export async function setLanePrOverride(
  sessionId: string,
  action: LanePrOverride,
  ref: GhPrRef,
): Promise<void> {
  if (!isPrRef(ref)) throw new Error('That is not a pull request link.')
  const lane = writableLane(sessionId)
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
  useLanePrOverridesStore.getState().record(lane, action, ref)
  // Main counts any prompt as unsettled work until a state read says otherwise;
  // without this, quitting after a Track would warn about unfinished work.
  await piCall(sessionId, { type: 'get_state' })
}
