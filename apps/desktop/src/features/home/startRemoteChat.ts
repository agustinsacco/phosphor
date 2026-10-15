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

/** A failed or uncertain receipt leaves the caller's draft untouched. Never retry automatically. */
export async function startRemoteChat(
  hostId: string,
  input: RemoteLaneCreate,
  text: string,
  attachments: PendingAttachment[],
  accepted: () => void,
): Promise<void> {
  const host = useRemoteLanesStore.getState().hosts[hostId]
  if (host?.state !== 'ready' || !host.capabilities.includes('sessions.control')) throw new Error()
  const nav = useSessionsStore.getState().claimNav()
  const info = await window.phosphor.invoke('hosts:createLane', hostId, input)
  if (input.model && input.provider)
    rememberRemoteModel(hostId, { id: input.model, provider: input.provider })
  await adoptRemoteLane(info, nav)
  if (!info.laneId) throw new Error()
  if (!canControlSession(info.sessionId))
    await window.phosphor.invoke('hosts:takeControl', hostId, info.laneId)
  // Main rechecks the fence; the renderer must not attempt a viewer prompt.
  const fresh = await window.phosphor.invoke('hosts:snapshot')
  useRemoteLanesStore.setState({ hosts: fresh })
  if (!canControlSession(info.sessionId)) throw new Error()
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
  accepted()
}
