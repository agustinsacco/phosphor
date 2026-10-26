import { useExtensionUiStore } from '@/stores/extensionUi'
import type { LanePreflight } from './deletePreflight'
import { DeleteSessionModal } from './DeleteSessionModal'
import { BulkDeleteModal } from './BulkDeleteModal'
import { forgetRemoteSession } from '@/stores/sessions'
import { useState } from 'react'
import type { HostLaneView } from '@shared/ipc'
import { hostResourceKey } from '@shared/remote-host'
import { useChatStore } from '@/stores/chat'
import { laneIsBeingDeleted } from '@/stores/sessions'
import { useSessionsStore } from '@/stores/sessions'
import {
  useRemoteLanesStore,
  openRemoteLane,
  machineLabel,
  REMOTE_NOT_READY,
  REMOTE_UNAVAILABLE,
} from '@/stores/remoteLanes'
import { piCall, piCallOk } from '@/lib/rpc'
import { showContextMenu, showMenuBelow, type ContextMenuItem } from '@/components/ContextMenu'
import { TextInput } from '@/components/form'
import { RemoteLanePresentation, useRemoteLaneTitle } from './RemoteLanePresentation'
export { remoteLaneTitle } from './remoteLaneView'
import { openPullRequest } from './PrBadge'
import { useRemotePr } from './remotePullRequests'
import { LaneMarker } from './LaneMarker'
import { MarkerPickerModal } from './MarkerPickerModal'

export const TAKE_CONTROL_FIRST = 'Take control first.'
export const ONLY_WHILE_RUNNING = 'Only while running.'

/**
 * Why a controller-only row action is disabled, or undefined when control is
 * not the obstacle. Not holding control is the common case and the user can fix
 * it, so it must not read as a permanent gap (the generic text did, and left a
 * viewer believing Delete was impossible).
 */
export function remoteControlHint(
  ready: boolean,
  canControl: boolean,
  self: boolean,
): string | undefined {
  if (!ready) return REMOTE_NOT_READY
  if (!canControl) return REMOTE_UNAVAILABLE
  return self ? undefined : TAKE_CONTROL_FIRST
}

/** Remote curation uses durable Host/lane identities, never transport handles. */
export function RemoteLaneRow({
  hostId,
  lane,
  ready,
  active,
}: {
  hostId: string
  lane: HostLaneView
  ready: boolean
  active: boolean
}): React.JSX.Element {
  const entry = useSessionsStore((s) =>
    Object.values(s.live).find(
      (e) => e.target?.kind === 'remote' && e.target.hostId === hostId && e.laneId === lane.laneId,
    ),
  )
  const host = useRemoteLanesStore((s) => s.hosts[hostId])
  const key = hostResourceKey({ kind: 'remote', hostId }, 'session', lane.laneId)
  const pinned = useSessionsStore((s) => s.pinned.includes(key))
  const marker = useSessionsStore((s) => s.laneMarkers[key])
  const [renaming, setRenaming] = useState(false)
  const [draft, setDraft] = useState('')
  const [picking, setPicking] = useState(false)
  const deletingInBulk = useSessionsStore((s) => laneIsBeingDeleted(s.bulkDelete, key))
  const [actionBusy, setBusy] = useState(false)
  const busy = actionBusy || deletingInBulk
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const title = useRemoteLaneTitle(lane, hostId)
  const { pr } = useRemotePr(hostId, lane)
  const controlled =
    ready &&
    !!host?.capabilities.includes('sessions.control') &&
    lane.control.controller?.self === true
  const running = lane.activity !== 'stopped' && lane.activity !== 'failed'
  const canWrite = !!host?.capabilities.includes('workspaces.write')
  const controlHint = remoteControlHint(
    ready,
    !!host?.capabilities.includes('sessions.control'),
    lane.control.controller?.self === true,
  )
  async function act(action: () => Promise<unknown>): Promise<void> {
    setBusy(true)
    try {
      await action()
    } catch {
      useRemoteLanesStore.setState({
        error: 'The Host could not confirm this. Check the lane before retrying.',
      })
    } finally {
      setBusy(false)
    }
  }
  async function session(): Promise<string> {
    if (entry) return entry.phosphorId
    const info = await window.phosphor.invoke('hosts:openLane', hostId, lane.laneId)
    await useSessionsStore
      .getState()
      .adoptSession(info.sessionId, info.workspacePath, undefined, info)
    return info.sessionId
  }
  function rename(): void {
    setDraft(title === 'Untitled lane' ? '' : title)
    setRenaming(true)
  }
  async function save(): Promise<void> {
    if (!controlled || !running || !draft.trim() || busy) return
    await act(async () => {
      const id = await session()
      if (!(await piCallOk(id, { type: 'set_session_name', name: draft.trim() }))) throw new Error()
      useChatStore.getState().patchMeta(id, { sessionName: draft.trim() })
      setRenaming(false)
    })
  }
  const ownsWorktree =
    lane.worktree &&
    !host?.lanes.some((other) => other.laneId !== lane.laneId && other.cwd === lane.cwd)
  const preflight: LanePreflight = {
    path: key,
    title,
    marker: marker ?? '',
    dirtyCount: 0,
    warnings: lane.activity === 'working' ? ['running'] : [],
  }
  const finishDelete = async ({ branchKept }: { branchKept: boolean }): Promise<void> => {
    if (entry) await forgetRemoteSession(entry.phosphorId)
    if (branchKept)
      useExtensionUiStore.getState().pushToast("Branch kept: it isn't merged yet.", 'info')
  }
  const items: ContextMenuItem[] = [
    ...(pr
      ? [{ label: `Open pull request #${pr.number}`, onClick: () => void openPullRequest(pr) }]
      : []),
    {
      label: 'Open',
      disabled: !ready || busy,
      hint: !ready ? REMOTE_NOT_READY : undefined,
      onClick: () => void openRemoteLane(hostId, lane.laneId),
    },
    {
      label: 'Rename',
      disabled: !controlled || !running || busy,
      hint: controlHint ?? (!running ? ONLY_WHILE_RUNNING : undefined),
      onClick: rename,
    },
    ...(!lane.control.controller?.self
      ? [
          {
            label: 'Take control',
            disabled: !ready || !host?.capabilities.includes('sessions.control') || busy,
            hint: !ready ? REMOTE_NOT_READY : undefined,
            onClick: () =>
              void act(() => window.phosphor.invoke('hosts:takeControl', hostId, lane.laneId)),
          },
        ]
      : []),
    ...(lane.control.controller?.self
      ? [
          {
            label: 'Release control',
            disabled: !controlled || busy,
            hint: controlHint,
            onClick: () =>
              void act(() => window.phosphor.invoke('hosts:releaseControl', hostId, lane.laneId)),
          },
        ]
      : []),
    {
      label: running ? 'Stop' : 'Resume',
      disabled: !controlled || busy,
      hint: controlHint,
      onClick: () =>
        void act(() =>
          window.phosphor.invoke(
            running ? 'hosts:stopLane' : 'hosts:resumeLane',
            hostId,
            lane.laneId,
          ),
        ),
    },
    {
      label: 'Mark read',
      disabled: !ready || busy,
      hint: !ready ? REMOTE_NOT_READY : undefined,
      onClick: () => void act(() => window.phosphor.invoke('hosts:markRead', hostId, lane.laneId)),
    },
    { label: pinned ? 'Unpin' : 'Pin', onClick: () => useSessionsStore.getState().togglePin(key) },
    { label: 'Lane marker', onClick: () => setPicking(true) },
    {
      label: 'Copy debug info',
      onClick: () =>
        void act(() =>
          navigator.clipboard.writeText(
            `Machine: ${machineLabel(hostId)}\nHost: ${hostId}\nLane: ${lane.laneId}\nBranch: ${lane.branch ?? 'none'}`,
          ),
        ),
    },
    {
      label: 'Copy spend',
      disabled: !ready || busy || !running,
      hint: !ready ? REMOTE_NOT_READY : !running ? ONLY_WHILE_RUNNING : undefined,
      onClick: () =>
        void act(async () => {
          const stats = await piCall(await session(), { type: 'get_session_stats' })
          if (!stats) throw new Error()
          await navigator.clipboard.writeText(
            JSON.stringify(
              stats,
              (key, value: unknown) =>
                key === 'sessionFile' || key === 'sessionId' ? undefined : value,
              2,
            ),
          )
        }),
    },
    {
      label: 'Delete',
      danger: true,
      separatorAbove: true,
      disabled: !controlled || !canWrite || busy,
      hint: controlHint ?? (!canWrite ? REMOTE_UNAVAILABLE : undefined),
      onClick: () => setDeleting(true),
    },
  ]
  return (
    <>
      {deleting && !ownsWorktree && (
        <DeleteSessionModal
          remote
          target={{ title, workspacePath: entry?.workspacePath ?? '' }}
          onClose={() => setDeleting(false)}
          onRemove={async () => {
            if (!controlled || !host?.capabilities.includes('workspaces.write')) throw new Error()
            const result = await window.phosphor.invoke('hosts:deleteLane', hostId, lane.laneId, {
              removeWorktree: false,
              removeBranch: false,
            })
            await finishDelete(result)
          }}
        />
      )}
      {deleting && ownsWorktree && (
        <BulkDeleteModal
          remote
          busy={busy}
          error={deleteError}
          summary={{
            lanes: [preflight],
            deletable: [preflight],
            warnings: preflight.warnings,
            needsAcknowledgement: preflight.warnings.length > 0,
            worktreeCount: ownsWorktree ? 1 : 0,
          }}
          onCancel={() => {
            if (!busy) setDeleting(false)
          }}
          onConfirm={(options) => {
            if (!controlled || !host?.capabilities.includes('workspaces.write') || busy) return
            setBusy(true)
            setDeleteError(null)
            void window.phosphor
              .invoke('hosts:deleteLane', hostId, lane.laneId, {
                removeWorktree: ownsWorktree && options.removeWorktree,
                removeBranch: ownsWorktree && options.removeWorktree && options.deleteBranch,
              })
              .then(async (result) => {
                await finishDelete(result)
                setDeleting(false)
              })
              .catch(() =>
                setDeleteError(
                  'The Host could not delete this lane. Check the lane before retrying.',
                ),
              )
              .finally(() => setBusy(false))
          }}
        />
      )}

      {renaming ? (
        <div className="px-3 py-2">
          <TextInput
            autoFocus
            aria-label="Lane name"
            maxLength={80}
            value={draft}
            disabled={busy}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => {
              if (!draft.trim()) setRenaming(false)
              else void save()
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setRenaming(false)
              if (e.key === 'Enter') void save()
            }}
          />
        </div>
      ) : (
        <RemoteLanePresentation
          hostId={hostId}
          lane={lane}
          title={title}
          ready={ready}
          disabled={!ready || deletingInBulk}
          active={active}
          pinned={pinned}
          marker={<LaneMarker marker={marker ?? ''} onPick={() => setPicking(true)} />}
          onClick={() => {
            if (ready) void openRemoteLane(hostId, lane.laneId)
          }}
          onDoubleClick={() => {
            if (controlled && running) rename()
          }}
          onContextMenu={(e) => showContextMenu(e, items)}
          onKeyDown={(e) => {
            if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
              e.preventDefault()
              showMenuBelow(e.currentTarget, items)
            }
          }}
        />
      )}
      {picking && (
        <MarkerPickerModal
          title={title}
          current={marker}
          autoKey={lane.branch}
          mode="manual"
          usedMarkers={new Set()}
          onPick={(next) => {
            useSessionsStore.getState().setLaneMarker(key, next)
            setPicking(false)
          }}
          onClose={() => setPicking(false)}
        />
      )}
    </>
  )
}
