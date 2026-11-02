import { remoteBranchName } from './remoteBranchName'
import { ipcErrorText } from '@shared/errors'
import { rememberRemoteModel } from '@/stores/remoteModelPicks'
import type { RemoteLaneCreate } from '@shared/ipc'
import type { PendingAttachment } from '@/features/chat/attachments'
import {
  composePrompt,
  toImageContents,
  remotePromptAttachments,
} from '@/features/chat/attachments'
import { useSessionsStore } from '@/stores/sessions'
import { useRemoteLanesStore, canControlSession, adoptRemoteLane } from '@/stores/remoteLanes'
import { piCallOk } from '@/lib/rpc'
import { useStartingChatStore } from '@/stores/startingChat'
import { requestSwarm } from '@/lib/swarm'
import { LANE_STARTED_UNOPENED, PROMPT_UNCONFIRMED } from './remoteStartCodes'

/**
 * Only a definitive fresh-branch refusal may retry. Uncertain receipts keep the draft.
 *
 * A `laneStart` Host takes a text-only first prompt with the creation and finds a
 * free branch name itself, so the lane comes up already working in one round
 * trip. Attachments and Swarm need the lane to exist first, and older Hosts take
 * neither, so those still open the lane, upload, and send the prompt from here.
 */
export async function startRemoteChat(
  hostId: string,
  input: RemoteLaneCreate,
  text: string,
  attachments: PendingAttachment[],
  accepted: () => void,
  swarm = false,
): Promise<void> {
  const host = useRemoteLanesStore.getState().hosts[hostId]
  if (host?.state !== 'ready' || !host.capabilities.includes('sessions.control')) throw new Error()
  const inline = host.laneStart === true && attachments.length === 0 && !swarm
  const nav = useSessionsStore.getState().claimNav()
  // The Host already tries -2…-5 itself; a refusal from it means none was free.
  const attempts = host.laneStart ? 1 : 5
  const create = async () => {
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        return await window.phosphor.invoke('hosts:createLane', hostId, {
          ...input,
          ...(input.worktree?.fresh
            ? { worktree: { branch: remoteBranchName(text, attempt), fresh: true } }
            : {}),
          ...(inline ? { prompt: text } : {}),
        })
      } catch (error) {
        if (!input.worktree?.fresh || ipcErrorText(error) !== 'branch-exists') throw error
      }
    }
    throw new Error('branch-name-exhausted')
  }
  const info = await create().catch((error: unknown) => {
    // The Host ran the prompt but main could not open the lane: the draft is spent.
    if (ipcErrorText(error) === LANE_STARTED_UNOPENED) accepted()
    throw error
  })
  if (input.model && input.provider)
    rememberRemoteModel(hostId, { id: input.model, provider: input.provider })
  const laneId = info.laneId
  if (!laneId) throw new Error()
  // Only a prompt sent with the creation can be in doubt; otherwise it is ours to send.
  const prompted = inline ? info.prompted : false
  if (prompted === undefined) {
    // The lane exists; whether it is working is the Host's to show.
    await adoptRemoteLane(info, nav)
    throw new Error(PROMPT_UNCONFIRMED)
  }
  // The Host ran it: the draft is spent whatever opening the lane here does.
  if (prompted) accepted()
  // Until this lane's first prompt is in, the echo stands in for its empty transcript.
  else
    useStartingChatStore
      .getState()
      .cover(hostId, input.repositoryId, { sessionId: info.sessionId, laneId })
  await adoptRemoteLane(info, nav)
  if (prompted) return
  await sendFirstPrompt(hostId, { sessionId: info.sessionId, laneId }, text, attachments, swarm)
  accepted()
}

async function sendFirstPrompt(
  hostId: string,
  info: { sessionId: string; laneId: string },
  text: string,
  attachments: PendingAttachment[],
  swarm: boolean,
): Promise<void> {
  if (!canControlSession(info.sessionId)) {
    await window.phosphor.invoke('hosts:takeControl', hostId, info.laneId)
    // Main rechecks the fence; the renderer must not attempt a viewer prompt.
    const fresh = await window.phosphor.invoke('hosts:snapshot')
    useRemoteLanesStore.setState({ hosts: fresh })
  }
  if (!canControlSession(info.sessionId)) throw new Error()
  // As on This Mac: the first prompt never runs without the authorization the user chose.
  if (swarm)
    await requestSwarm(info.sessionId, true).catch(() => Promise.reject(new Error('swarm-failed')))
  const uploaded = await remotePromptAttachments(attachments, (files) =>
    window.phosphor.invoke('hosts:uploadAttachments', info.sessionId, files),
  )
  if (
    !(await piCallOk(info.sessionId, {
      type: 'prompt',
      message: composePrompt(text, uploaded),
      images: toImageContents(uploaded),
    }))
  )
    throw new Error()
}
