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
  notice: { message: string; kind?: Toast['kind']; title?: string },
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
      // Live name first: pi writes a rename to disk only when a turn ends.
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
 * Nothing for the lane on screen — the transcript already shows it — and
 * nothing for an aborted run, which only the stop control produces.
 */
export function noticeLaneSettled(sessionId: string): void {
  if (laneOnScreen(sessionId)) return
  const items = useChatStore.getState().sessions[sessionId]?.items ?? []
  const outcome = laneOutcome(items)
  if (!outcome) return
  if (outcome.kind === 'error') {
    notifyLane(sessionId, {
      kind: 'error',
      message: outcome.excerpt ? `Stopped: ${outcome.excerpt}` : 'Stopped with an error.',
    })
    return
  }
  notifyLane(sessionId, { kind: 'success', message: outcome.excerpt ?? 'Finished.' })
}
