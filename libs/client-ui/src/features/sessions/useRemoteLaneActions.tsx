import { useState } from 'react'
import type { HostLaneView } from '@shared/ipc'
import { remoteLaneResourceKey } from '@shared/remote-host'
import type { ContextMenuItem } from '@/components/ContextMenu'
import { piCall, piCallOk } from '@/lib/rpc'
import { remoteLaneMarker } from './remoteLaneView'
import { useNavigation, type Navigation } from '@/navigation/Navigation'
import { usePlatform } from '@/platform/Platform'
import { useChatStore } from '@/stores/chat'
import { useMachineCaps } from '@/stores/machineCaps'
import { setRemoteLaneMarks } from '@/stores/remoteLaneMarks'
import { machineLabel, useRemoteLanesStore } from '@/stores/remoteLanes'
import { laneIsBeingDeleted, useSessionsStore } from '@/stores/sessions'
import { useLanePrefsStore } from '@/stores/lanePrefs'
import { makeRoutine } from '@/stores/routines'
import { STOP_NEEDS_PROMPT } from '@/features/machines/useLaneControl'
import { openPullRequest } from './PrBadge'
import { useRemotePr } from './remotePullRequests'
import { useRemoteLaneTitle } from './RemoteLanePresentation'
import { laneActions, type LaneActionHandlers, type LaneActions } from './laneActions'
import { hostLaneContext, remoteLaneAccess, type RemoteLaneActionState } from './remoteLaneActions'
import { RemoteLaneDeleteDialog } from './RemoteLaneDeleteDialog'
import { copyDebugInfo, copySpend, exportRemoteLaneHtml } from './sessionActions'
import { openLaneMove } from './sidebarActions'
import type { SessionDebugSource } from '@/lib/sessionDebugInfo'
import { MarkerPickerModal } from './MarkerPickerModal'
import { useSessionOrderActions } from './SessionList'

const ACTION_FAILED = 'The Host could not confirm this. Check the lane before retrying.'
type LaneDialog = 'delete' | 'marker' | null
type HostLaneChannel =
  | 'hosts:takeControl'
  | 'hosts:releaseControl'
  | 'hosts:stopLane'
  | 'hosts:resumeLane'
  | 'hosts:markRead'

/** The shared lane actions, plus what a Host lane's surfaces also show: control, the rename and a refusal. */
export interface RemoteLaneActions extends LaneActions, ReturnType<typeof remoteLaneAccess> {
  title: string
  busy: boolean
  /** The last refused action's reason, for a sheet that stays open to explain it. */
  error: string | null
  deletingInBulk: boolean
  /** Names the lane through its live session; resolves false when the Host refused. */
  saveName: (name: string) => Promise<boolean>
  marker: string | null
}

/**
 * One Host lane's actions and the dialogs they open, for any surface that
 * offers them. The surface presents `items()` (a context menu, a phone sheet),
 * renders `dialogs` and decides how a rename is asked for. `onDone` runs once
 * an action is confirmed or has handed off to its dialog, so a sheet can close
 * then and stay open to explain a refusal (`error`).
 */
export function useRemoteLaneActions({
  hostId,
  lane,
  ready,
  withOpen = true,
  onRename,
  onDone,
}: {
  hostId: string
  lane: HostLaneView
  ready: boolean
  /** Offer Open; off where the surface already is the lane. */
  withOpen?: boolean
  onRename: () => void
  onDone?: () => void
}): RemoteLaneActions {
  const { navigate } = useNavigation()
  const { nativeFiles } = usePlatform()
  const orderActions = useSessionOrderActions()
  const entry = useRemoteLaneSession(hostId, lane.laneId)
  const runner = useLaneActionRunner(onDone)
  const [dialog, setDialog] = useState<LaneDialog>(null)
  const title = useRemoteLaneTitle(lane, hostId)
  const { state, pr, deletingInBulk, marker } = useLaneActionState(
    hostId,
    lane,
    ready,
    entry?.phosphorId,
    runner.busy,
    nativeFiles,
  )
  const access = remoteLaneAccess(state)
  const session = async (): Promise<string> => entry?.phosphorId ?? openLaneSession(hostId, lane)
  const handlers = laneHandlers({
    hostId,
    lane,
    navigate: withOpen ? navigate : undefined,
    pr,
    act: runner.act,
    sessionId: entry?.phosphorId,
    session,
    exportAs: { title, nativeFiles },
    onRename,
    openDialog: (next) => {
      setDialog(next)
      onDone?.()
    },
    onMarked: () => onDone?.(),
  })

  /** Names the lane through its live session; resolves false when the Host refused. */
  const saveName = async (name: string): Promise<boolean> =>
    access.controlled && access.running && !!name.trim() && !state.busy
      ? runner.act(async () => renameLane(await session(), name.trim()))
      : false
  const dialogs = (
    <RemoteLaneDialogs
      dialog={dialog}
      hostId={hostId}
      lane={lane}
      title={title}
      sessionId={entry?.phosphorId}
      workspacePath={entry?.workspacePath ?? ''}
      allowed={access.controlled && access.canWrite}
      onClose={() => setDialog(null)}
    />
  )
  return {
    items: (): ContextMenuItem[] => laneActions(hostLaneContext(state), handlers, orderActions),
    dialogs,
    title,
    busy: state.busy,
    error: runner.error,
    deletingInBulk,
    saveName,
    pickMarker: access.canMark && state.markers !== 'off' ? handlers.marker : undefined,
    marker,
    ...access,
  }
}

/** What the lane's menu is built from: the Host view, its pull request, and what is in flight. */
function useLaneActionState(
  hostId: string,
  lane: HostLaneView,
  ready: boolean,
  sessionId: string | undefined,
  running: boolean,
  nativeFiles: boolean,
) {
  const caps = useMachineCaps(hostId)
  const key = remoteLaneResourceKey(hostId, lane.laneId)
  const deletingInBulk = useSessionsStore((s) => laneIsBeingDeleted(s.bulkDelete, key))
  // pi writes nothing to resume until a first message, so the Host refuses Stop before one.
  const unprompted = useChatStore(
    (s) => !!sessionId && !s.sessions[sessionId]?.items.some((item) => item.kind === 'user'),
  )
  const pr = useRemotePr(hostId, lane)
  const markers = useLanePrefsStore((s) => s.lanes.markers)
  const state: RemoteLaneActionState = {
    lane,
    caps,
    ready,
    busy: running || deletingInBulk,
    stopBlocked: unprompted ? STOP_NEEDS_PROMPT : null,
    pr: pr ?? null,
    markers,
    ...(!nativeFiles ? { moveBlocked: 'Moving lanes requires Desktop.' } : {}),
  }
  /** The row's marker: the explicit Host choice, else derived from the branch, as on This Mac. */
  const marker = markers === 'off' ? null : remoteLaneMarker(lane, markers)
  return { state, pr, deletingInBulk, marker }
}

/** The live session bound to a Host lane, once one has been opened. */
export function useRemoteLaneSession(hostId: string, laneId: string) {
  return useSessionsStore((s) =>
    Object.values(s.live).find(
      (e) => e.target?.kind === 'remote' && e.target.hostId === hostId && e.laneId === laneId,
    ),
  )
}

/** Runs one lane action at a time: busy while it runs, the refusal kept to explain it. */
function useLaneActionRunner(onDone: (() => void) | undefined) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function act(action: () => Promise<unknown>): Promise<boolean> {
    setBusy(true)
    try {
      await action()
      setError(null)
      onDone?.()
      return true
    } catch {
      setError(ACTION_FAILED)
      useRemoteLanesStore.setState({ error: ACTION_FAILED })
      return false
    } finally {
      setBusy(false)
    }
  }
  return { busy, error, act }
}

async function openLaneSession(hostId: string, lane: HostLaneView): Promise<string> {
  const info = await window.phosphor.invoke('hosts:openLane', hostId, lane.laneId)
  await useSessionsStore
    .getState()
    .adoptSession(info.sessionId, info.workspacePath, undefined, info)
  return info.sessionId
}

function laneHandlers({
  hostId,
  lane,
  navigate,
  pr,
  act,
  sessionId,
  session,
  exportAs: { title, nativeFiles },
  onRename,
  openDialog,
  onMarked,
}: {
  hostId: string
  lane: HostLaneView
  navigate: Navigation['navigate'] | undefined
  pr: Parameters<typeof openPullRequest>[0] | null | undefined
  act: (action: () => Promise<unknown>) => Promise<boolean>
  /** The lane's open session, if any; `session()` opens one when absent. */
  sessionId: string | undefined
  session: () => Promise<string>
  /** The export's file name, and whether this device saves through a dialog or a download. */
  exportAs: { title: string; nativeFiles: boolean }
  onRename: () => void
  openDialog: (dialog: LaneDialog) => void
  onMarked: () => void
}): LaneActionHandlers {
  const send = (channel: HostLaneChannel) => () =>
    void act(() => window.phosphor.invoke(channel, hostId, lane.laneId))
  // setRemoteLaneMarks reports its own failure, including the "update the Host" case.
  const mark = (change: Parameters<typeof setRemoteLaneMarks>[2]) =>
    void setRemoteLaneMarks(hostId, lane.laneId, change).then((ok) => {
      if (ok) onMarked()
    })
  return {
    // No pane: Desktop keeps the lane's own pane; the browser's lane URL defaults to chat.
    open: navigate && (() => navigate({ to: 'lane', lane: { hostId, laneId: lane.laneId } })),
    openPullRequest: () => {
      if (pr) void openPullRequest(pr)
    },
    rename: onRename,
    takeControl: send('hosts:takeControl'),
    releaseControl: send('hosts:releaseControl'),
    stop: send('hosts:stopLane'),
    resume: send('hosts:resumeLane'),
    markRead: send('hosts:markRead'),
    pin: () => mark({ pinned: !lane.pinned }),
    marker: () => openDialog('marker'),
    makeRoutine: () => void act(async () => routineFromLane(hostId, lane, await session())),
    exportHtml: () =>
      void act(async () => exportRemoteLaneHtml(await session(), title, nativeFiles)),
    // The Host exports only a stopped lane; the menu allows this only while it is idle.
    moveTo: () =>
      void act(async () => {
        if (lane.activity !== 'stopped' && lane.activity !== 'failed')
          await window.phosphor.invoke('hosts:stopLane', hostId, lane.laneId)
        openLaneMove({ machine: hostId, laneId: lane.laneId }, title, {
          pinned: lane.pinned === true,
          marker: remoteLaneMarker(lane, useLanePrefsStore.getState().lanes.markers),
        })
      }),
    copyDebugInfo: () =>
      void act(() => copyDebugInfo(remoteLaneDebugSource(hostId, lane, sessionId))),
    copySpend: () => void act(async () => copySpend(await sessionCost(await session()))),
    delete: () => openDialog('delete'),
  }
}

function RemoteLaneDialogs({
  dialog,
  hostId,
  lane,
  title,
  sessionId,
  workspacePath,
  allowed,
  onClose,
}: {
  dialog: LaneDialog
  hostId: string
  lane: HostLaneView
  title: string
  sessionId: string | undefined
  workspacePath: string
  allowed: boolean
  onClose: () => void
}): React.JSX.Element | null {
  const markers = useLanePrefsStore((s) => s.lanes.markers)
  // Read only while the picker is open: every row mounts these dialogs.
  const hostLanes = useRemoteLanesStore((s) =>
    dialog === 'marker' ? s.hosts[hostId]?.lanes : undefined,
  )
  if (dialog === 'delete')
    return (
      <RemoteLaneDeleteDialog
        hostId={hostId}
        lane={lane}
        title={title}
        sessionId={sessionId}
        workspacePath={workspacePath}
        allowed={allowed}
        onClose={onClose}
      />
    )
  if (dialog === 'marker' && markers !== 'off')
    return (
      <MarkerPickerModal
        title={title}
        current={lane.marker}
        autoKey={lane.branch || lane.cwd}
        mode={markers}
        usedMarkers={usedMarkers(hostLanes ?? [], lane)}
        onPick={(marker) => {
          onClose()
          void setRemoteLaneMarks(hostId, lane.laneId, { marker })
        }}
        onClose={onClose}
      />
    )
  return null
}

/**
 * Markers other lanes on this Host chose, in any folder, for the picker to dim:
 * This Mac dims every lane's choice on the machine too. Explicit choices only,
 * as on This Mac: derived markers collide by design.
 */
function usedMarkers(lanes: readonly HostLaneView[], lane: HostLaneView): Set<string> {
  return new Set(
    lanes.flatMap((other) => (other.laneId !== lane.laneId && other.marker ? [other.marker] : [])),
  )
}

async function renameLane(sessionId: string, name: string): Promise<void> {
  if (!(await piCallOk(sessionId, { type: 'set_session_name', name }))) throw new Error()
  useChatStore.getState().patchMeta(sessionId, { sessionName: name })
}

/**
 * "Make routine…" on a Host lane: This Mac's draft (the lane's own name, blank
 * when it has none, and its first prompt), opened on the lane's Host and
 * folder. The lane's session is open by now, so its transcript holds the first prompt.
 */
function routineFromLane(hostId: string, lane: HostLaneView, sessionId: string) {
  const chat = useChatStore.getState().sessions[sessionId]
  const first = chat?.items.find((i) => i.kind === 'user')
  const name = chat?.meta?.sessionName?.trim() || lane.title || ''
  makeRoutine('', name, first?.kind === 'user' ? first.text : '', {
    hostId,
    repositoryId: lane.repositoryId,
  })
}

async function sessionCost(sessionId: string): Promise<number> {
  const stats = await piCall(sessionId, { type: 'get_session_stats' })
  if (!stats) throw new Error()
  return stats.cost
}

/**
 * A Host lane's debug block: pi's id and model from its open session (else the
 * Host summary's model) and where it runs. Never a Host path: the lane's folder
 * and session file stay on the Host.
 */
function remoteLaneDebugSource(
  hostId: string,
  lane: HostLaneView,
  sessionId: string | undefined,
): SessionDebugSource {
  const meta = sessionId ? useChatStore.getState().sessions[sessionId]?.meta : null
  const model = meta?.model ?? lane.model
  return {
    sessionId: meta?.sessionId,
    provider: model?.provider,
    model: model?.id,
    context: [
      ['machine', machineLabel(hostId)],
      ['host', hostId],
      ['lane', lane.laneId],
      ['branch', lane.branch ?? 'none'],
    ],
  }
}
