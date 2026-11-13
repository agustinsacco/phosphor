import { appendToDraft, focusComposer } from '@/features/chat/composer/appendToDraft'
import { prHandoff } from '@/features/sessions/prHandoff'
import { useExtensionUiStore } from '@/stores/extensionUi'
import { prDetailOf, usePrDetailStore } from '@/stores/prDetail'
import { usePrInspectorStore } from '@/stores/prInspector'
import { usePrStatusStore } from '@/stores/prStatus'
import { navigateToLane } from '@/stores/remoteLanes'
import { useSessionsStore } from '@/stores/sessions'
import type { PrNotice, PrNoticeAction } from './prNotice'

/**
 * Go to the lane that owns the PR: its running session the way every lane
 * notice goes there, or its file when it is not running. Resolves to the
 * session id once that lane is on screen; null when the user went elsewhere
 * first or the lane is gone (which says so).
 */
export async function openPrLane(notice: Pick<PrNotice, 'lane'>): Promise<string | null> {
  const sessions = useSessionsStore.getState()
  const running = Object.values(sessions.live).find((entry) => entry.diskPath === notice.lane.path)
  if (running)
    return (await navigateToLane({ sessionId: running.phosphorId })) ? running.phosphorId : null
  const meta = sessions.disk[notice.lane.workspacePath]?.find((m) => m.path === notice.lane.path)
  try {
    if (!meta) throw new Error(`${notice.lane.title} is no longer on This Mac.`)
    const sessionId = await sessions.openDiskSession(notice.lane.workspacePath, meta)
    return useSessionsStore.getState().activeSessionId === sessionId ? sessionId : null
  } catch (error) {
    useExtensionUiStore
      .getState()
      .pushToast(error instanceof Error ? error.message : 'Could not open the lane.', 'error')
    return null
  }
}

/** Open lane: the lane, with its inspector asked to open on this PR. */
export async function openPrNotice(notice: Pick<PrNotice, 'lane' | 'key'>): Promise<void> {
  const sessionId = await openPrLane(notice)
  if (sessionId) usePrInspectorStore.getState().open(sessionId, notice.key)
}

/**
 * The notice's primary action. A hand-off drafts for the lane's agent from
 * the PR as it is now (and its detail, when the inspector read it), in that
 * lane's composer; it is never sent. A ready PR opens on GitHub.
 */
export async function runPrNoticeAction(notice: PrNotice, action: PrNoticeAction): Promise<void> {
  const summary = usePrStatusStore.getState().byKey[notice.key]?.summary ?? notice.summary
  if (action.kind === 'github') {
    await window.phosphor.invoke('app:openExternal', summary.url)
    return
  }
  const detail = prDetailOf(usePrDetailStore.getState(), notice.key).detail
  const sessionId = await openPrLane(notice)
  if (!sessionId) return
  appendToDraft(sessionId, prHandoff(action.handoff, summary, detail))
  focusComposer()
}
