import { useHostTraits } from '@/platform/machineTraits'
import { useWorktreesStore } from '@/stores/worktrees'
import { useState } from 'react'
import { useRemoteModel } from '@/features/machines/useRemoteModel'
import type { PendingAttachment } from '@/features/chat/attachments'
import { useDraftsStore } from '@/stores/drafts'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { machineCaps } from '@/stores/machineCaps'
import { rememberRemoteRepository, useRemoteComposer } from './remoteComposer'
import { submitRemoteHome } from './submitRemoteHome'

const EMPTY_ATTACHMENTS: PendingAttachment[] = []

/** Both shells resolve the same remembered target and submit through the same receipt fence. */
export function useRemoteStart(hostId: string, draftKey: string) {
  const host = useRemoteLanesStore((s) => s.hosts[hostId])
  const remembered = useRemoteComposer((s) => s.repositories[hostId])
  const repository =
    host?.repositories.find((r) => r.id === remembered) ?? host?.repositories[0] ?? null
  const repositoryId = repository?.id ?? ''
  // Only a Host that says git does not track the folder gets no worktree request;
  // an older or unsure Host is asked for one, and runs the lane in place if it must.
  const { sameMachine } = useHostTraits(hostId)
  const preferWorktree = useWorktreesStore((s) => s.preferWorktree)
  const canBranch = repository?.git !== false
  const selection = useRemoteModel(hostId)
  const draft = useDraftsStore((s) => s.drafts[draftKey])
  const text = draft?.text ?? ''
  const attachments = draft?.attachments ?? EMPTY_ATTACHMENTS
  const swarm = draft?.swarm ?? false
  const [warning, setWarning] = useState<string | null>(null)
  const ready = machineCaps(host).can('sessions.control')
  const canSend =
    ready && !!repositoryId && !!selection.model && (!!text.trim() || !!attachments.length)
  const send = async (): Promise<void> => {
    if (!canSend || !selection.model) return
    setWarning(null)
    // The composer clears at once; the create runs on behind its placeholder lane.
    await submitRemoteHome({
      hostId,
      draftKey,
      branch: canBranch && (!sameMachine || preferWorktree),
      input: {
        repositoryId,
        provider: selection.model.provider,
        model: selection.model.id,
        thinkingLevel: selection.thinking,
      },
    })
  }
  return {
    host,
    repositoryId,
    repository,
    selection,
    text,
    attachments,
    swarm,
    canBranch,
    isolate: sameMachine && canBranch && repositoryId ? preferWorktree : undefined,
    warning,
    setWarning,
    ready,
    canSend,
    send,
    setRepository: (id: string) => rememberRemoteRepository(hostId, id),
    setText: (value: string) => useDraftsStore.getState().setText(draftKey, value),
    setAttachments: (value: PendingAttachment[]) =>
      useDraftsStore.getState().setAttachments(draftKey, value),
    setSwarm: (enabled: boolean) => useDraftsStore.getState().patch(draftKey, { swarm: enabled }),
  }
}
