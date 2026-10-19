import { composePrompt, toImageContents, type PendingAttachment } from '@/features/chat/attachments'
import { startChat } from '@/features/sessions/startChat'
import { notifyLane } from '@/features/sessions/laneNotices'
import { useStartingChatStore } from '@/stores/startingChat'
import { useSessionsStore } from '@/stores/sessions'
import { useExtensionUiStore } from '@/stores/extensionUi'
import { useWritingStore } from '@/stores/writing'
import { homeDraftKey, useDraftsStore } from '@/stores/drafts'
import { ipcErrorText } from '@shared/errors'

export async function submitLocalHome(
  workspacePath: string,
  message: string,
  images: PendingAttachment[],
  swarm: boolean,
): Promise<void> {
  const prompt = composePrompt(message, images)
  const sent = toImageContents(images)
  // Commit before any await: StartingChat replaces Home and closes the double-send window.
  useStartingChatStore.getState().begin({ workspacePath, prompt, images: sent })
  useDraftsStore.getState().clear(homeDraftKey(workspacePath))
  // Claim navigation at the keystroke, not several seconds of git later.
  const nav = useSessionsStore.getState().claimNav()
  try {
    const started = await startChat({
      workspacePath,
      prompt,
      images: sent,
      swarm,
      nav,
      onPhase: (next) => useStartingChatStore.getState().setPhase(next),
      onWarning: (reason) => useExtensionUiStore.getState().pushToast(reason, 'warning'),
    })
    useStartingChatStore.getState().finish()
    useWritingStore.getState().recordPrompt(message)
    if (useSessionsStore.getState().navSeq !== nav)
      notifyLane(started.sessionId, { message: 'Your new lane is running.' })
  } catch (error) {
    // Home is already unmounted. Restore only into the workspace that submitted.
    useStartingChatStore.getState().restore({
      workspacePath,
      text: message,
      attachments: images,
      swarm,
      message: `Couldn't start this session. ${ipcErrorText(error)}`,
    })
  }
}
