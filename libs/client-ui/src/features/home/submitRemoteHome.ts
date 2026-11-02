import { ipcErrorText } from '@shared/errors'
import type { RemoteLaneCreate } from '@shared/ipc'
import { toImageContents, type PendingAttachment } from '@/features/chat/attachments'
import { useDraftsStore } from '@/stores/drafts'
import { useHomeSubmissionsStore } from '@/stores/homeSubmissions'
import { useExtensionUiStore } from '@/stores/extensionUi'
import { machineReadGeneration } from '@/stores/machineReadGeneration'
import { machineLabel } from '@/stores/remoteLanes'
import { useStartingChatStore } from '@/stores/startingChat'
import { startRemoteChat } from './startRemoteChat'
import { PROMPT_UNCONFIRMED } from './remoteStartCodes'
import { remoteBranchName } from './remoteBranchName'

interface Submission {
  hostId: string
  draftKey: string
  input: RemoteLaneCreate
  /** Authorize delegation before the first prompt; the lane is never prompted without it. */
  swarm?: boolean
  text: string
  attachments: PendingAttachment[]
}

/** Fixed codes from `hosts:createLane` and `startRemoteChat`; anything else stays uncertain. */
function createWarning(code: string, machine: string): string {
  switch (code) {
    case 'branch-name-exhausted':
      return `Couldn't find a free branch name on ${machine}.`
    case 'branch-prefix-too-long':
      return 'Branch prefix is too long for a Host worktree. Shorten it in Settings.'
    case 'lane-create-failed':
      return `${machine} couldn't start this lane. Your draft is kept.`
    case PROMPT_UNCONFIRMED:
      return `${machine} started the lane but couldn't confirm it got your message. Check the lane before sending it again. Your draft is kept.`
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
 * Claims outlive the view, but not an owner reset. Only a confirmed receipt spends a draft.
 *
 * Every Host lane asks for a fresh worktree: work never lands on the repository's
 * main checkout, and every lane has a branch to open a PR from. The Host runs a
 * folder outside git in place, unbranched.
 *
 * The send is committed on screen at once, as on This Mac: the starting echo replaces the
 * composer until the lane has the message, and a failure brings the composer back with
 * its draft and the reason.
 */
export async function submitRemoteHome(s: Submission): Promise<void> {
  const claims = useHomeSubmissionsStore.getState()
  if (!claims.begin(s.draftKey)) return
  claims.warn(s.draftKey, null)
  useStartingChatStore.getState().begin({
    prompt: s.text,
    images: toImageContents(s.attachments),
    remote: { hostId: s.hostId, repositoryId: s.input.repositoryId, draftKey: s.draftKey },
  })
  let active = true
  const unsubscribe = useHomeSubmissionsStore.subscribe((state) => {
    if (!state.pending[s.draftKey]) active = false
  })
  const revision = useDraftsStore.getState().revisions[s.draftKey]
  const generation = machineReadGeneration(s.hostId)
  const current = () => active && generation === machineReadGeneration(s.hostId)
  try {
    await startRemoteChat(
      s.hostId,
      { ...s.input, worktree: { branch: remoteBranchName(s.text), fresh: true } },
      s.text,
      s.attachments,
      () => {
        if (current() && useDraftsStore.getState().revisions[s.draftKey] === revision)
          useDraftsStore.getState().clear(s.draftKey)
      },
      // Only an opted-in lane passes the flag, so the call stays what it was without one.
      ...(s.swarm ? ([true] as const) : ([] as const)),
    )
  } catch (failure) {
    if (!current()) return
    const message = createWarning(ipcErrorText(failure), machineLabel(s.hostId))
    useHomeSubmissionsStore.getState().warn(s.draftKey, message)
    useExtensionUiStore.getState().pushToast(message, 'warning')
  } finally {
    unsubscribe()
    useStartingChatStore.getState().finish(s.draftKey)
    if (active) useHomeSubmissionsStore.getState().finish(s.draftKey)
  }
}
