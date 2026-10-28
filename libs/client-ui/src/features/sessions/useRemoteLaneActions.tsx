import { useState } from 'react'
import type { HostLaneView } from '@shared/ipc'
import { hostResourceKey } from '@shared/remote-host'
import type { ContextMenuItem } from '@/components/ContextMenu'
import { piCall, piCallOk } from '@/lib/rpc'
import { useNavigation, type Navigation } from '@/navigation/Navigation'
import { useChatStore } from '@/stores/chat'
import { setRemoteLaneMarks } from '@/stores/remoteLaneMarks'
import { machineLabel, useRemoteLanesStore } from '@/stores/remoteLanes'
import { laneIsBeingDeleted, useSessionsStore } from '@/stores/sessions'
import { STOP_NEEDS_PROMPT } from '@/features/machines/useLaneControl'
import { openPullRequest } from './PrBadge'
import { useRemotePr } from './remotePullRequests'
import { useRemoteLaneTitle } from './RemoteLanePresentation'
import {
  remoteLaneAccess,
  remoteLaneActions,
  type RemoteLaneActionHandlers,
  type RemoteLaneActionState,
} from './remoteLaneActions'
import { RemoteLaneDeleteDialog } from './RemoteLaneDeleteDialog'
import { MarkerPickerModal } from './MarkerPickerModal'

const ACTION_FAILED = 'The Host could not confirm this. Check the lane before retrying.'
type LaneDialog = 'delete' | 'marker' | null
type HostLaneChannel =
  | 'hosts:takeControl'
  | 'hosts:releaseControl'
  | 'hosts:stopLane'
  | 'hosts:resumeLane'
  | 'hosts:markRead'

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
}) {
  const { navigate } = useNavigation()
  const entry = useRemoteLaneSession(hostId, lane.laneId)
  const runner = useLaneActionRunner(onDone)
  const [dialog, setDialog] = useState<LaneDialog>(null)
  const title = useRemoteLaneTitle(lane, hostId)
  const { state, pr, deletingInBulk } = useLaneActionState(
    hostId,
    lane,
    ready,
    entry?.phosphorId,
    runner.busy,
  )
  const busy = state.busy
  const access = remoteLaneAccess(state)

  const act = runner.act
  const session = async (): Promise<string> => entry?.phosphorId ?? openLaneSession(hostId, lane)
  const handlers = laneHandlers({
    hostId,
    lane,
    navigate: withOpen ? navigate : undefined,
    pr,
    act,
    session,
    onRename,
    openDialog: (next) => {
      setDialog(next)
      onDone?.()
    },
    onMarked: () => onDone?.(),
  })

  /** Names the lane through its live session; resolves false when the Host refused. */
  const saveName = async (name: string): Promise<boolean> =>
    access.controlled && access.running && !!name.trim() && !busy
      ? act(async () => renameLane(await session(), name.trim()))
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
    items: (): ContextMenuItem[] => remoteLaneActions(state, handlers),
    dialogs,
    title,
    busy,
    error: runner.error,
    deletingInBulk,
    saveName,
    pickMarker: access.canMark ? handlers.pickMarker : undefined,
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
) {
  const host = useRemoteLanesStore((s) => s.hosts[hostId])
  const key = hostResourceKey({ kind: 'remote', hostId }, 'session', lane.laneId)
  const deletingInBulk = useSessionsStore((s) => laneIsBeingDeleted(s.bulkDelete, key))
  // pi writes nothing to resume until a first message, so the Host refuses Stop before one.
  const unprompted = useChatStore(
    (s) => !!sessionId && !s.sessions[sessionId]?.items.some((item) => item.kind === 'user'),
  )
  const { pr } = useRemotePr(hostId, lane)
  const state: RemoteLaneActionState = {
    lane,
    host,
    ready,
    busy: running || deletingInBulk,
    stopBlocked: unprompted ? STOP_NEEDS_PROMPT : null,
    pr: pr ?? null,
  }
  return { state, pr, deletingInBulk }
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
  session,
  onRename,
  openDialog,
  onMarked,
}: {
  hostId: string
  lane: HostLaneView
  navigate: Navigation['navigate'] | undefined
  pr: Parameters<typeof openPullRequest>[0] | null | undefined
  act: (action: () => Promise<unknown>) => Promise<boolean>
  session: () => Promise<string>
  onRename: () => void
  openDialog: (dialog: LaneDialog) => void
  onMarked: () => void
}): RemoteLaneActionHandlers {
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
    togglePin: () => mark({ pinned: !lane.pinned }),
    pickMarker: () => openDialog('marker'),
    copyDebugInfo: () =>
      void act(() =>
        navigator.clipboard.writeText(
          `Machine: ${machineLabel(hostId)}\nHost: ${hostId}\nLane: ${lane.laneId}\nBranch: ${lane.branch ?? 'none'}`,
        ),
      ),
    copySpend: () => void act(async () => copySpend(await session())),
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
  if (dialog === 'marker')
    return (
      <MarkerPickerModal
        title={title}
        current={lane.marker}
        autoKey={lane.branch}
        mode="manual"
        usedMarkers={new Set()}
        onPick={(marker) => {
          onClose()
          void setRemoteLaneMarks(hostId, lane.laneId, { marker })
        }}
        onClose={onClose}
      />
    )
  return null
}

async function renameLane(sessionId: string, name: string): Promise<void> {
  if (!(await piCallOk(sessionId, { type: 'set_session_name', name }))) throw new Error()
  useChatStore.getState().patchMeta(sessionId, { sessionName: name })
}

async function copySpend(sessionId: string): Promise<void> {
  const stats = await piCall(sessionId, { type: 'get_session_stats' })
  if (!stats) throw new Error()
  await navigator.clipboard.writeText(
    JSON.stringify(
      stats,
      (key, value: unknown) => (key === 'sessionFile' || key === 'sessionId' ? undefined : value),
      2,
    ),
  )
}
