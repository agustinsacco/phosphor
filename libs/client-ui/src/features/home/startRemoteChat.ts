import { uploadPromptFiles } from '@/features/chat/uploadPromptFiles'
import { ensureServiceLaneControl } from '@/platform/serviceLaneControl'
import { remoteBranchName } from './remoteBranchName'
import { ipcErrorText } from '@shared/errors'
import { rememberRemoteModel } from '@/stores/remoteModelPicks'
import type { RemoteLaneCreate } from '@shared/ipc'
import type { LiveSessionInfo } from '@shared/models'
import type { PendingAttachment } from '@/features/chat/attachments'
import { composePrompt, toImageContents } from '@/features/chat/attachments'
import { useSessionsStore } from '@/stores/sessions'
import { useRemoteLanesStore, canControlSession, adoptRemoteLane } from '@/stores/remoteLanes'
import { machineCaps } from '@/stores/machineCaps'
import { refreshHostsSnapshot } from '@/stores/hostsSnapshotRead'
import { piCallOk } from '@/lib/rpc'
import { requestSwarm } from '@/lib/swarm'

/** What a background create (`submitRemoteHome`) follows while it runs. */
export interface LaneCreateHooks {
  /** The navigation the adopt activates for; -1 never takes the screen. Default: claimed now. */
  nav?: number
  /** Each fresh branch name asked for, before its request goes out. */
  trying?: (branch: string) => void
  /** A name the Host refused as taken: whatever lane carries it is not this create's. */
  refused?: (branch: string) => void
  /** The Host made the lane, before it is adopted; from here a failure is no longer a failed create. */
  created?: (info: LiveSessionInfo) => void
  /** Adopted, before control and files: the Host takes files only for the lane on screen. */
  adopted?: () => void
  /** Again right before files upload: the user may have come back to the placeholder since. */
  uploading?: () => void
}

/** Only a definitive fresh-branch refusal may retry. Uncertain receipts keep the draft. */
export async function startRemoteChat(
  hostId: string,
  input: RemoteLaneCreate,
  text: string,
  attachments: PendingAttachment[],
  accepted: () => void,
  swarm = false,
  hooks: LaneCreateHooks = {},
): Promise<void> {
  const host = useRemoteLanesStore.getState().hosts[hostId]
  if (!host || !machineCaps(host).can('sessions.control')) throw new Error()
  const nav = hooks.nav ?? useSessionsStore.getState().claimNav()
  const create = async () => {
    for (let attempt = 1; attempt <= 5; attempt++) {
      const branch = input.worktree?.fresh ? remoteBranchName(text, attempt) : undefined
      if (branch) hooks.trying?.(branch)
      try {
        return await window.phosphor.invoke('hosts:createLane', hostId, {
          ...input,
          ...(branch ? { worktree: { branch, fresh: true } } : {}),
        })
      } catch (error) {
        if (!branch || ipcErrorText(error) !== 'branch-exists') throw error
        hooks.refused?.(branch)
      }
    }
    throw new Error('branch-name-exhausted')
  }
  const info = await create()
  if (input.model && input.provider)
    rememberRemoteModel(hostId, { id: input.model, provider: input.provider })
  if (!info.laneId) throw new Error()
  hooks.created?.(info)
  await adoptRemoteLane(info, nav)
  hooks.adopted?.()
  if (host.local) {
    await refreshHostsSnapshot()
    await ensureServiceLaneControl(hostId, info.laneId)
  } else if (!canControlSession(info.sessionId))
    await window.phosphor.invoke('hosts:takeControl', hostId, info.laneId)
  // Main rechecks the fence; the renderer must not attempt a viewer prompt.
  await refreshHostsSnapshot()
  if (!canControlSession(info.sessionId)) throw new Error()
  // As on This Mac: the first prompt never runs without the authorization the user chose.
  if (swarm)
    await requestSwarm(info.sessionId, true).catch(() => Promise.reject(new Error('swarm-failed')))
  hooks.uploading?.()
  const uploaded = await uploadPromptFiles(info.sessionId, attachments)
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
