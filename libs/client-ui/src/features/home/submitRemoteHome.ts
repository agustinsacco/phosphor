import { ipcErrorText } from '@shared/errors'
import type { RemoteLaneCreate } from '@shared/ipc'
import type { PendingAttachment } from '@/features/chat/attachments'
import { useDraftsStore } from '@/stores/drafts'
import { useHomeSubmissionsStore } from '@/stores/homeSubmissions'
import { useExtensionUiStore } from '@/stores/extensionUi'
import { machineReadGeneration } from '@/stores/machineReadGeneration'
import { machineLabel } from '@/stores/remoteLanes'
import { startRemoteChat } from './startRemoteChat'
import { remoteBranchName } from './remoteBranchName'

interface Submission {
  hostId: string
  draftKey: string
  input: RemoteLaneCreate
  isolate: boolean
  text: string
  attachments: PendingAttachment[]
  onWarning: (message: string) => void
}

/** Claims outlive the view, but not an owner reset. Only a confirmed receipt spends a draft. */
export async function submitRemoteHome(s: Submission): Promise<void> {
  const claims = useHomeSubmissionsStore.getState()
  if (!claims.begin(s.draftKey)) return
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
      {
        ...s.input,
        ...(s.isolate ? { worktree: { branch: remoteBranchName(s.text), fresh: true } } : {}),
      },
      s.text,
      s.attachments,
      () => {
        if (current() && useDraftsStore.getState().revisions[s.draftKey] === revision)
          useDraftsStore.getState().clear(s.draftKey)
      },
    )
  } catch (failure) {
    if (!current()) return
    const code = ipcErrorText(failure)
    const message =
      code === 'branch-name-exhausted'
        ? `Couldn't find a free branch name on ${machineLabel(s.hostId)}.`
        : code === 'branch-prefix-too-long'
          ? 'Branch prefix is too long for a Host worktree. Shorten it in Settings.'
          : 'The Host could not confirm this. Check the lane before retrying. Your draft is kept.'
    s.onWarning(message)
    useExtensionUiStore.getState().pushToast(message, 'warning')
  } finally {
    unsubscribe()
    if (active) useHomeSubmissionsStore.getState().finish(s.draftKey)
  }
}
