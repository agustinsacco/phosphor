import type { ChatSessionState } from '@/features/chat/chatItems'
import { laneReceipt } from './laneReceipt'
import { useChatStore } from '@/stores/chat'
import { useExtensionUiStore, type Toast } from '@/stores/extensionUi'
import { useLanePrefsStore } from '@/stores/lanePrefs'
import { useLayoutStore } from '@/stores/layout'
import { useSessionsStore } from '@/stores/sessions'
import { laneMarker } from '@/lib/laneMarker'
import { laneOutcome } from '@/lib/laneNotice'
import { sessionTitle } from '@/lib/sessionTitle'

/**
 * Notices about a lane the user is not looking at: it came up, it was named,
 * it finished. Each one names the lane the way its sidebar row does (title and
 * marker) and clicking it goes there.
 *
 * A lane holds one notice at a time (`sessionId` in the toast store), so a
 * lane that comes up, gets named and then finishes behind your back is one
 * card that updates, not three.
 */
export function notifyLane(
  sessionId: string,
  notice: { message: string; kind?: Toast['kind']; title?: string; receipt?: Toast['receipt'] },
): void {
  const sessions = useSessionsStore.getState()
  const live = sessions.live[sessionId]
  if (!live) return
  const chat = useChatStore.getState().sessions[sessionId]
  const scanned = live.diskPath
    ? sessions.disk[live.workspacePath]?.find((meta) => meta.path === live.diskPath)
    : undefined
  const firstUser = chat?.items.find((item) => item.kind === 'user')
  const title =
    notice.title ??
    sessionTitle({
      // Live name first: the disk scan lags a rename by its debounce.
      explicitName: chat?.meta?.sessionName ?? scanned?.name,
      firstUserText:
        (firstUser?.kind === 'user' ? firstUser.text : undefined) ?? scanned?.firstUserText,
    }) ??
    'Untitled lane'
  const marker = laneMarker(
    live.diskPath ? sessions.laneMarkers[live.diskPath] : undefined,
    sessions.gitByCwd[live.workspacePath]?.branch,
    live.workspacePath,
    useLanePrefsStore.getState().lanes.markers,
  )
  useExtensionUiStore.getState().notify({
    sessionId,
    receipt: notice.receipt?.facts
      ? { ...notice.receipt, facts: { ...notice.receipt.facts, title } }
      : notice.receipt,
    title,
    message: notice.message,
    kind: notice.kind ?? 'info',
    marker: marker || undefined,
    openLabel: 'Open lane',
    onOpen: () => {
      const current = useSessionsStore.getState()
      // Closed since the notice went up: nothing to go to.
      if (current.live[sessionId]) current.activate(sessionId)
    },
  })
}

/** Is this lane the one on screen right now? A global page covers it. */
export function laneOnScreen(sessionId: string): boolean {
  return (
    useSessionsStore.getState().activeSessionId === sessionId &&
    useLayoutStore.getState().page === null
  )
}

/**
 * A lane's run just settled. Say so if the user is somewhere else.
 *
 * Nothing for the lane on screen: the transcript already shows it. The
 * caller skips an aborted run, which only the stop control produces.
 */
export function noticeLaneSettled(
  sessionId: string,
  startedAt?: number | null,
  settledAt = Date.now(),
  settledChat?: Pick<ChatSessionState, 'items' | 'tools'>,
): void {
  if (laneOnScreen(sessionId)) return
  const items = settledChat?.items ?? useChatStore.getState().sessions[sessionId]?.items ?? []
  const live = useSessionsStore.getState().live[sessionId]
  const chat = useChatStore.getState().sessions[sessionId]
  const facts = laneReceipt({
    workspacePath: live?.workspacePath,
    items,
    tools: settledChat?.tools ?? chat?.tools ?? {},
    title: chat?.meta?.sessionName ?? 'Untitled lane',
    repository:
      (live
        ? (useSessionsStore.getState().gitByCwd[live.workspacePath]?.mainRepoPath ??
          live.workspacePath)
        : undefined
      )
        ?.split('/')
        .pop() ?? null,
    branch: live
      ? (useSessionsStore.getState().gitByCwd[live.workspacePath]?.branch ?? null)
      : null,
    startedAt,
    settledAt,
  })
  const receipt = { facts, machine: 'This Mac', at: new Date(settledAt).toISOString() }
  const outcome = laneOutcome(items)
  if (outcome.kind === 'error') {
    notifyLane(sessionId, {
      receipt,
      kind: 'error',
      message: outcome.excerpt ? `Stopped: ${outcome.excerpt}` : 'Stopped with an error.',
    })
    return
  }
  notifyLane(sessionId, { receipt, kind: 'success', message: outcome.excerpt ?? 'Finished.' })
}
