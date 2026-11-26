import { ServiceLaneControlRefused } from '@/platform/serviceLaneControl'
import { ipcErrorText, WORKTREE_GIT_TIMEOUT } from '@shared/errors'
import type { RemoteLaneCreate } from '@shared/ipc'
import { useExtensionUiStore } from '@/stores/extensionUi'
import { machineLabel } from '@/stores/remoteLanes'
import {
  beginLaneCreate,
  failLaneCreate,
  finishLaneCreate,
  laneCreate,
  laneCreateAdopted,
  laneCreateShown,
  laneCreated,
  noteLaneCreateBranch,
  refuseLaneCreateBranch,
  type LaneCreate,
} from '@/stores/laneCreates'
import { startRemoteChat } from './startRemoteChat'
import { remoteBranchName } from './remoteBranchName'

interface Submission {
  hostId: string
  draftKey: string
  input: RemoteLaneCreate
  /** False when the Host says git does not track the folder: no worktree to ask for. */
  branch: boolean
}

/** Refusals that mean the Host made no lane. Any other code may have made one. */
const DEFINITE = new Set([
  'branch-name-exhausted',
  'branch-prefix-too-long',
  'lane-create-failed',
  WORKTREE_GIT_TIMEOUT,
  'lane-limit',
])

/** Fixed codes from `hosts:createLane` and `startRemoteChat`; anything else stays uncertain. */
function createWarning(code: string, machine: string): string {
  switch (code) {
    case 'branch-name-exhausted':
      return `Couldn't find a free branch name on ${machine}.`
    case 'branch-prefix-too-long':
      return 'Branch prefix is too long for a Host worktree. Shorten it in Settings.'
    case 'lane-create-failed':
      return `${machine} couldn't start this lane. Your draft is kept.`
    case WORKTREE_GIT_TIMEOUT:
      return `${WORKTREE_GIT_TIMEOUT}. Your draft is kept.`
    case 'lane-limit':
      // The Host also sends too-many-requests for too many commands in flight.
      return `${machine} is at its lane limit or too busy. Try again, or delete a lane there.`
    case 'swarm-failed':
      return `${machine} couldn't turn on Swarm (it needs pi-subagents there), so the new lane got no first message. Your draft is kept.`
    default:
      return 'The Host could not confirm this. Check the lane before retrying. Your draft is kept.'
  }
}

/**
 * Sends from a New lane composer without waiting on the Host: the composer
 * clears, a starting placeholder lane takes the screen and its folder's top
 * row, and the create, takeover and first prompt run in the background. The
 * user may start more at once or go anywhere; a create that lands while its
 * placeholder is on screen becomes that lane in place.
 *
 * Every Host lane asks for a fresh worktree: work never lands on the repository's
 * main checkout, and every lane has a branch to open a PR from. A folder the Host
 * reports outside git asks for none; it runs in place, unbranched.
 */
export function submitRemoteHome(s: Submission): Promise<void> {
  // The draft is read here, at Enter, and taken in the same tick: a second Enter finds it empty.
  const create = beginLaneCreate({
    hostId: s.hostId,
    repositoryId: s.input.repositoryId,
    draftKey: s.draftKey,
  })
  return create ? runLaneCreate(create, s) : Promise.resolve()
}

async function runLaneCreate(
  { id, text, attachments, swarm }: LaneCreate,
  s: Submission,
): Promise<void> {
  try {
    await startRemoteChat(
      s.hostId,
      s.branch
        ? { ...s.input, worktree: { branch: remoteBranchName(text), fresh: true } }
        : s.input,
      text,
      attachments,
      () => {},
      swarm,
      {
        nav: -1,
        trying: (branch) => noteLaneCreateBranch(id, branch),
        refused: (branch) => refuseLaneCreateBranch(id, branch),
        created: (info) => laneCreated(id, info),
        adopted: () => laneCreateAdopted(id),
        uploading: () => laneCreateAdopted(id),
      },
    )
    finishLaneCreate(id)
  } catch (failure) {
    const create = laneCreate(id)
    // Dismissed, or retired by an owner reset.
    if (!create) return
    const code = ipcErrorText(failure)
    const message =
      failure instanceof ServiceLaneControlRefused
        ? failure.message
        : createWarning(code, machineLabel(s.hostId))
    const shown = laneCreateShown(id)
    // The lane exists; only what followed failed. Its text waits on its own composer.
    if (create.laneId) finishLaneCreate(id, true)
    else failLaneCreate(id, message, !DEFINITE.has(code))
    if (!shown || create.laneId) useExtensionUiStore.getState().pushToast(message, 'warning')
  }
}
