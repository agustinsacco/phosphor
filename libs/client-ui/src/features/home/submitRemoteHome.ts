import { ServiceLaneControlRefused } from '@/platform/serviceLaneControl'
import { ipcErrorText } from '@shared/errors'
import type { RemoteLaneCreate } from '@shared/ipc'
import type { PendingAttachment } from '@/features/chat/attachments'
import { useDraftsStore } from '@/stores/drafts'
import { useExtensionUiStore } from '@/stores/extensionUi'
import { machineLabel } from '@/stores/remoteLanes'
import {
  beginLaneCreate,
  failLaneCreate,
  fileOnLane,
  finishLaneCreate,
  laneCreate,
  laneCreateShown,
  laneCreated,
  noteLaneCreateBranch,
} from '@/stores/laneCreates'
import { startRemoteChat } from './startRemoteChat'
import { remoteBranchName } from './remoteBranchName'

interface Submission {
  hostId: string
  draftKey: string
  input: RemoteLaneCreate
  /** Authorize delegation before the first prompt; the lane is never prompted without it. */
  swarm?: boolean
  /** False when the Host says git does not track the folder: no worktree to ask for. */
  branch: boolean
  text: string
  attachments: PendingAttachment[]
}

/** Refusals that mean the Host made no lane. Any other code may have made one. */
const DEFINITE = new Set([
  'branch-name-exhausted',
  'branch-prefix-too-long',
  'lane-create-failed',
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
  const id = beginLaneCreate({
    hostId: s.hostId,
    repositoryId: s.input.repositoryId,
    draftKey: s.draftKey,
    title: s.text || 'New lane',
    text: s.text,
    attachments: s.attachments,
    swarm: !!s.swarm,
  })
  useDraftsStore.getState().clear(s.draftKey)
  return runLaneCreate(id, s)
}

async function runLaneCreate(id: string, s: Submission): Promise<void> {
  try {
    await startRemoteChat(
      s.hostId,
      s.branch
        ? { ...s.input, worktree: { branch: remoteBranchName(s.text), fresh: true } }
        : s.input,
      s.text,
      s.attachments,
      () => {},
      !!s.swarm,
      {
        nav: -1,
        trying: (branch) => noteLaneCreateBranch(id, branch),
        created: (info) => laneCreated(id, info),
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
    if (create.laneId) {
      // The lane exists; only what followed failed. Its text waits in its own composer.
      fileOnLane(create, create.laneId)
      finishLaneCreate(id)
      useExtensionUiStore.getState().pushToast(message, 'warning')
      return
    }
    const shown = laneCreateShown(id)
    failLaneCreate(id, message, !DEFINITE.has(code))
    if (!shown) useExtensionUiStore.getState().pushToast(message, 'warning')
  }
}
