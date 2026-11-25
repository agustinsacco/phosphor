/**
 * Whether pi may be processing a lane: a run, its compaction or retry, a prompt it
 * has not answered, queued messages, a question, or background agents whose
 * results start a turn on their own. pi refuses a plain prompt while it
 * processes, so the composer then sends a steer or a follow-up, which pi starts
 * as an ordinary prompt if it is idle by the time the message arrives.
 *
 * The chat store alone is not enough: it marks the lane idle at the run's end and
 * cannot see a Host lane's activity, nor the background agents that keep it working.
 */
import type { LaneActivity } from '@shared/host-protocol'
import { useChatStore, type ChatSession } from '@/stores/chat'
import { useExtensionUiStore } from '@/stores/extensionUi'
import { sessionHostLane, useSessionHostLane } from '@/stores/remoteLanes'
import { hasDelegatedWork, SUBAGENT_ASYNC_WIDGET_KEY } from './subagentRuns'

function chatBusy(chat: ChatSession | undefined): boolean {
  return (
    !!chat &&
    (chat.isStreaming ||
      chat.isCompacting ||
      chat.promptSentAt != null ||
      chat.retry != null ||
      chat.queues.steering.length + chat.queues.followUp.length > 0)
  )
}

type ExtensionUi = Pick<ReturnType<typeof useExtensionUiStore.getState>, 'dialogs' | 'widgets'>

function extensionBusy(ui: ExtensionUi, sessionId: string): boolean {
  return (
    ui.dialogs.some((dialog) => dialog.sessionId === sessionId) ||
    hasDelegatedWork(ui.widgets[sessionId]?.[SUBAGENT_ASYNC_WIDGET_KEY]?.lines)
  )
}

/** A Host lane's activity; This Mac's in-app lanes have none. */
const hostBusy = (activity: LaneActivity | undefined): boolean =>
  activity === 'working' || activity === 'needs-input'

/** Read at the moment of sending, never from a render that may be stale. */
export function laneBusyNow(sessionId: string): boolean {
  return (
    chatBusy(useChatStore.getState().sessions[sessionId]) ||
    extensionBusy(useExtensionUiStore.getState(), sessionId) ||
    hostBusy(sessionHostLane(sessionId)?.lane?.activity)
  )
}

/** `laneBusyNow` for a component: it re-renders when the answer changes. */
export function useLaneBusy(sessionId: string): boolean {
  const chat = useChatStore((s) => chatBusy(s.sessions[sessionId]))
  const extension = useExtensionUiStore((s) => extensionBusy(s, sessionId))
  const host = hostBusy(useSessionHostLane(sessionId)?.lane?.activity)
  return chat || extension || host
}
