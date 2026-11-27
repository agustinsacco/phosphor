import { useHostLaneBrainMenu } from './useHostLaneBrainMenu'
import { runLaneAction, laneActionErrorText } from '@/platform/serviceLaneControl'
import { HostTreeDialog, useEditingMenu } from '@/features/chat/HostTreeDialog'
import { useHostTraits } from '@/platform/machineTraits'
import { useState } from 'react'
import type { HostLaneView } from '@shared/ipc'
import { remoteLaneResourceKey } from '@shared/remote-host'
import type { ContextMenuItem } from '@/components/ContextMenu'
import { remoteLaneMarker } from './remoteLaneView'
import { useNavigation, type Navigation } from '@/navigation/Navigation'
import { usePlatform } from '@/platform/Platform'
import { useChatStore } from '@/stores/chat'
import { adoptHostLane } from '@/stores/hostLaneOpen'
import { useMachineCaps } from '@/stores/machineCaps'
import { setRemoteLaneMarks } from '@/stores/remoteLaneMarks'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { laneIsBeingDeleted, useSessionsStore } from '@/stores/sessions'
import { useLanePrefsStore } from '@/stores/lanePrefs'
import { STOP_NEEDS_PROMPT } from '@/features/machines/useLaneControl'
import { lanePrMenuEntries, openLanePr, useRemoteLanePrs } from './lanePrMenu'
import type { LanePr } from './lanePrs'
import { usePrInspectorStore } from '@/stores/prInspector'
import { useRemoteLaneTitle } from './RemoteLanePresentation'
import type { LaneActionHandlers, LaneActions } from './laneActions'
import { hostLaneContext, remoteLaneAccess, type RemoteLaneActionState } from './remoteLaneActions'
import { RemoteLaneDeleteDialog } from './RemoteLaneDeleteDialog'
import { copyDebugInfo, copySpend, exportRemoteLaneHtml } from './sessionActions'
import { openLaneMove } from './sidebarActions'
import { MarkerPickerModal } from './MarkerPickerModal'
import { useSessionOrderActions } from './SessionList'
import {
  remoteLaneDebugSource,
  renameLane,
  renameSavedHostLane,
  routineFromLane,
  sessionCost,
  usedMarkers,
} from './remoteLaneSessionHelpers'

type LaneDialog = 'delete' | 'marker' | 'tree' | null
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
  canRename: boolean
  /** Resolves false when the Host refused. */
  saveName: (name: string) => Promise<boolean>
  marker: string | null
  /** For the menu's trigger: `onOpen` reads what only an open menu shows; `revision` rebuilds it. */
  menuTrigger: { onOpen: () => void; revision: string }
}

interface RemoteLaneActionProps {
  hostId: string
  lane: HostLaneView
  ready: boolean
  /** Offer Open; off where the surface already is the lane. */
  withOpen?: boolean
  onRename: () => void
  onDone?: () => void
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
}: RemoteLaneActionProps): RemoteLaneActions {
  const { navigate } = useNavigation()
  const { nativeFiles } = usePlatform()
  const orderActions = useSessionOrderActions()
  const entry = useRemoteLaneSession(hostId, lane.laneId)
  const runner = useLaneActionRunner(onDone)
  const { dialog, setDialog, openDialog } = useLaneDialog(onDone)
  const title = useRemoteLaneTitle(lane, hostId)
  const brain = useHostLaneBrainMenu(hostId, lane.laneId, title)
  const { state, prs, deletingInBulk, marker } = useLaneActionState(
    hostId,
    lane,
    ready,
    entry?.phosphorId,
    runner.busy,
  )
  const editing = useEditingMenu(hostId, lane, !state.stopBlocked, setDialog, runner.act)
  const access = remoteLaneAccess(state)
  const context = hostLaneContext(state)
  const canRename = !context.busy && !context.refusals.rename
  const session = async (): Promise<string> =>
    entry?.phosphorId ?? adoptHostLane({ hostId, laneId: lane.laneId }, false)
  const handlers = laneHandlers({
    hostId,
    lane,
    navigate: withOpen ? navigate : undefined,
    prs,
    act: runner.act,
    sessionId: entry?.phosphorId,
    session,
    exportAs: { title, nativeFiles },
    onRename,
    openDialog,
    onMarked: () => onDone?.(),
  })

  const saveName = laneNameSaver(canRename, state.caps.laneRename, runner.act, {
    saved: (name) => renameSavedHostLane(hostId, lane.laneId, name, entry?.phosphorId),
    running: async (name) => renameLane(await session(), name),
  })
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
    items: (): ContextMenuItem[] => brain.items(context, { ...handlers, ...editing }, orderActions),
    dialogs: combinedLaneDialogs(brain.dialog, dialogs),
    title,
    busy: state.busy,
    error: runner.error,
    deletingInBulk,
    canRename,
    saveName,
    pickMarker: access.canMark && state.markers !== 'off' ? handlers.marker : undefined,
    marker,
    menuTrigger: { onOpen: brain.onMenuOpen, revision: `${lane.activity}|${brain.revision}` },
    ...access,
  }
}

function combinedLaneDialogs(brain: React.ReactNode, dialogs: React.ReactNode) {
  return (
    <>
      {brain}
      {dialogs}
    </>
  )
}

/** The lane's open dialog; opening one also closes whatever surface asked for it. */
function useLaneDialog(onDone: (() => void) | undefined) {
  const [dialog, setDialog] = useState<LaneDialog>(null)
  const openDialog = (next: LaneDialog): void => {
    setDialog(next)
    onDone?.()
  }
  return { dialog, setDialog, openDialog }
}

/**
 * Saves a typed name: a Host that renames saved lanes takes every rename; an older one
 * only a running lane's, through pi. Blank, or not renamable now, saves nothing.
 */
function laneNameSaver(
  canRename: boolean,
  hostRenames: boolean,
  act: (action: () => Promise<unknown>) => Promise<boolean>,
  rename: {
    saved: (name: string) => Promise<unknown>
    running: (name: string) => Promise<unknown>
  },
): (name: string) => Promise<boolean> {
  return async (name) => {
    const trimmed = name.trim()
    if (!canRename || !trimmed) return false
    return act(() => (hostRenames ? rename.saved(trimmed) : rename.running(trimmed)))
  }
}

/** What the lane's menu is built from: the Host view, its pull request, and what is in flight. */
function useLaneActionState(
  hostId: string,
  lane: HostLaneView,
  ready: boolean,
  sessionId: string | undefined,
  running: boolean,
) {
  const { sameMachine } = useHostTraits(hostId)
  const caps = useMachineCaps(hostId)
  const key = remoteLaneResourceKey(hostId, lane.laneId)
  const deletingInBulk = useSessionsStore((s) => laneIsBeingDeleted(s.bulkDelete, key))
  // pi writes nothing to resume until a first message, so the Host refuses Stop before one.
  const unprompted = useChatStore(
    (s) => !!sessionId && !s.sessions[sessionId]?.items.some((item) => item.kind === 'user'),
  )
  const prs = useRemoteLanePrs(hostId, lane)
  const markers = useLanePrefsStore((s) => s.lanes.markers)
  const state: RemoteLaneActionState = {
    lane,
    caps,
    sameMachine,
    ready,
    busy: running || deletingInBulk,
    stopBlocked: unprompted ? STOP_NEEDS_PROMPT : null,
    prs: lanePrMenuEntries(prs),
    markers,
  }
  /** The row's marker: the explicit Host choice, else derived from the branch, as on This Mac. */
  const marker = markers === 'off' ? null : remoteLaneMarker(lane, markers)
  return { state, prs, deletingInBulk, marker }
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
    } catch (error) {
      const message = laneActionErrorText(error)
      setError(message)
      useRemoteLanesStore.setState({ error: message })
      return false
    } finally {
      setBusy(false)
    }
  }
  return { busy, error, act }
}

function laneHandlers({
  hostId,
  lane,
  navigate,
  prs,
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
  /** The lane's own PRs, lead first. */
  prs: LanePr[]
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
    void act(() => runLaneAction(channel, hostId, lane.laneId))
  // setRemoteLaneMarks reports its own failure, including the "update the Host" case.
  const mark = (change: Parameters<typeof setRemoteLaneMarks>[2]) =>
    void setRemoteLaneMarks(hostId, lane.laneId, change).then((ok) => {
      if (ok) onMarked()
    })
  return {
    // No pane: Desktop keeps the lane's own pane; the browser's lane URL defaults to chat.
    open: navigate && (() => navigate({ to: 'lane', lane: { hostId, laneId: lane.laneId } })),
    openPullRequest: (key) => openLanePr(prs, key),
    // Opens the lane's session, asks its pill for the inspector, then shows the lane.
    showPullRequests: () =>
      void act(async () => {
        usePrInspectorStore.getState().open(await session())
        navigate?.({ to: 'lane', lane: { hostId, laneId: lane.laneId } })
      }),
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
          await runLaneAction('hosts:stopLane', hostId, lane.laneId)
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
  if (dialog === 'tree')
    return <HostTreeDialog hostId={hostId} laneId={lane.laneId} title={title} onClose={onClose} />
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
