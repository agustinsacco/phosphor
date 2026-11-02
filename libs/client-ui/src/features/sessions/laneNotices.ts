import type { ChatSessionState } from '@/features/chat/chatItems'
import { laneReceipt } from './laneReceipt'
import { remoteLaneMarker } from './remoteLaneView'
import { localMachineLabel } from '@/lib/localMachine'
import { useChatStore } from '@/stores/chat'
import { useExtensionUiStore, type Toast } from '@/stores/extensionUi'
import { useLanePrefsStore } from '@/stores/lanePrefs'
import { useLayoutStore } from '@/stores/layout'
import { useSessionsStore } from '@/stores/sessions'
import { machineLabel, navigateToLane, useRemoteLanesStore } from '@/stores/remoteLanes'
import type { HostAttention } from '@shared/ipc'
import { laneMarker } from '@/lib/laneMarker'
import { laneOutcome } from '@/lib/laneNotice'
import { sessionTitle } from '@/lib/sessionTitle'
import { quietReleaseRun, RELEASE_STATUS_KEY } from '@phosphor/pi-extensions/release-status'

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
  showLaneNotice({
    sessionId,
    receipt: notice.receipt?.facts
      ? { ...notice.receipt, facts: { ...notice.receipt.facts, title } }
      : notice.receipt,
    title,
    message: notice.message,
    kind: notice.kind ?? 'info',
    marker: laneMarker(
      live.diskPath ? sessions.laneMarkers[live.diskPath] : undefined,
      sessions.gitByCwd[live.workspacePath]?.branch,
      live.workspacePath,
      useLanePrefsStore.getState().lanes.markers,
    ),
    onOpen: () => navigateToLane({ sessionId }),
  })
}

/** The one lane card, for This Mac's lanes and a Host's: one per lane, opening it on click. */
function showLaneNotice(
  notice: Pick<Toast, 'sessionId' | 'receipt' | 'title' | 'message' | 'kind' | 'onOpen'> & {
    marker: string
  },
): void {
  useExtensionUiStore.getState().notify({
    ...notice,
    marker: notice.marker || undefined,
    openLabel: 'Open lane',
  })
}

/**
 * The lane is in front of the user: on screen in a focused window. A lane on
 * screen in a background window still gets its notice, on every machine.
 */
function laneInView(sessionId: string | undefined): boolean {
  return !!sessionId && laneOnScreen(sessionId) && document.hasFocus()
}

/** A settled run's line: the reply's excerpt, or why it stopped. One wording for every machine. */
function settledNotice(outcome: { kind: 'done' | 'error'; excerpt?: string | null }): {
  kind: Toast['kind']
  message: string
} {
  if (outcome.kind === 'error')
    return {
      kind: 'error',
      message: outcome.excerpt ? `Stopped: ${outcome.excerpt}` : 'Stopped with an error.',
    }
  return { kind: 'success', message: outcome.excerpt || 'Finished.' }
}

/**
 * A Host attention's line when it carries no receipt. `routine` folds a
 * finished routine and a paused one together, so without a receipt it stays neutral.
 */
const ATTENTION_NOTICE: Record<HostAttention['kind'], ReturnType<typeof settledNotice>> = {
  finished: settledNotice({ kind: 'done' }),
  failed: settledNotice({ kind: 'error' }),
  'needs-input': { kind: 'info', message: 'Needs your input.' },
  routine: { kind: 'info', message: 'Routine update.' },
}

/** A settled run's receipt words the notice, as on This Mac; a Host's attention carries one only for a settled run. */
function attentionNotice(event: HostAttention): ReturnType<typeof settledNotice> {
  return event.receipt && event.kind !== 'needs-input'
    ? settledNotice({ kind: event.receipt.outcome, excerpt: event.receipt.excerpt })
    : ATTENTION_NOTICE[event.kind]
}

/**
 * A Host lane needs attention. Worded and marked as This Mac's lanes are; an
 * adopted lane shares its session's card, so a settled notice is replaced, not
 * doubled. Nothing for the lane in front of the user.
 */
export function noticeHostAttention(
  event: HostAttention,
  sessionId: string | undefined,
  onOpen: () => Promise<boolean>,
): void {
  if (laneInView(sessionId)) return
  const lane = useRemoteLanesStore
    .getState()
    .hosts[event.hostId]?.lanes.find((l) => l.laneId === event.laneId)
  const machine = machineLabel(event.hostId)
  showLaneNotice({
    sessionId,
    title: `${machine} · ${event.title}`,
    ...attentionNotice(event),
    marker: lane ? remoteLaneMarker(lane, useLanePrefsStore.getState().lanes.markers) : '',
    receipt: {
      facts: event.receipt,
      machine,
      machineId: event.hostId,
      laneId: event.laneId,
      at: event.at,
    },
    onOpen,
  })
}

/** Is this lane the one on screen right now? A global page covers it. */
function laneOnScreen(sessionId: string): boolean {
  return (
    useSessionsStore.getState().activeSessionId === sessionId &&
    useLayoutStore.getState().page === null
  )
}

/**
 * A lane's run just settled. Say so if the user is somewhere else.
 *
 * Nothing for the lane in front of the user (`laneInView`): the transcript
 * already shows it. The caller skips an aborted run, which only the stop
 * control produces.
 */
export function noticeLaneSettled(
  sessionId: string,
  startedAt?: number | null,
  settledAt = Date.now(),
  settledChat?: Pick<ChatSessionState, 'items' | 'tools'>,
): void {
  if (laneInView(sessionId)) return
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
  const receipt = { facts, machine: localMachineLabel(), at: new Date(settledAt).toISOString() }
  const outcome = laneOutcome(items)
  // A release lane's routine pass ends silently; a failed run still announces itself.
  if (
    outcome.kind !== 'error' &&
    quietReleaseRun(useExtensionUiStore.getState().statuses[sessionId]?.[RELEASE_STATUS_KEY])
  )
    return
  notifyLane(sessionId, { receipt, ...settledNotice(outcome) })
}
