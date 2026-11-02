import { usePlatform } from '@/platform/Platform'
import { useRemoteModel } from '@/features/machines/RemoteModelPicker'
import type { PendingAttachment } from '@/features/chat/attachments'
import { useDraftsStore } from '@/stores/drafts'
import { useHomeSubmissionsStore } from '@/stores/homeSubmissions'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { rememberRemoteRepository, useRemoteComposer } from './remoteComposer'
import { submitRemoteHome } from './submitRemoteHome'

const EMPTY_ATTACHMENTS: PendingAttachment[] = []

/** Both shells resolve the same remembered target and submit through the same receipt fence. */
export function useRemoteStart(hostId: string, draftKey: string) {
  const { nativeFiles } = usePlatform()
  const host = useRemoteLanesStore((s) => s.hosts[hostId])
  const remembered = useRemoteComposer((s) => s.repositories[hostId])
  const repositoryId =
    host?.repositories.find((r) => r.id === remembered)?.id ?? host?.repositories[0]?.id ?? ''
  const selection = useRemoteModel(hostId)
  const draft = useDraftsStore((s) => s.drafts[draftKey])
  const text = draft?.text ?? ''
  const attachments = draft?.attachments ?? EMPTY_ATTACHMENTS
  const swarm = draft?.swarm ?? false
  const busy = useHomeSubmissionsStore((s) => !!s.pending[draftKey])
  // In the store, not local state: the composer that sent is replaced while it starts.
  const warning = useHomeSubmissionsStore((s) => s.warnings[draftKey] ?? null)
  const setWarning = (message: string | null) =>
    useHomeSubmissionsStore.getState().warn(draftKey, message)
  const ready = host?.state === 'ready' && host.capabilities.includes('sessions.control')
  const canSend =
    ready && !!repositoryId && !!selection.model && (!!text.trim() || !!attachments.length)
  const send = async (): Promise<void> => {
    if (!canSend || !selection.model || useHomeSubmissionsStore.getState().pending[draftKey]) return
    if (!nativeFiles && attachments.some((attachment) => attachment.kind !== 'image')) {
      setWarning('Only images can be attached in this browser. Remove other files before starting.')
      return
    }
    setWarning(null)
    await submitRemoteHome({
      hostId,
      draftKey,
      text: text.trim(),
      attachments,
      swarm,
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
    selection,
    text,
    attachments,
    swarm,
    busy,
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
