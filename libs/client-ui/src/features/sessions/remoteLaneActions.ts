import type { ContextMenuItem } from '@/components/ContextMenu'
import { featureNotOffered } from '@/stores/hostRefusals'
import { REMOTE_NOT_READY, REMOTE_UNAVAILABLE } from '@/stores/remoteLanes'
import type { HostConnectionView, HostLaneView } from '@shared/ipc'
import type { LanePrefs } from '@shared/models'

export const TAKE_CONTROL_FIRST = 'Take control first.'
export const ONLY_WHILE_RUNNING = 'Only while running.'
/** A Host older than `laneMarks` cannot keep pins or markers, and only that Host can. */
export const LANE_MARKS_NEED_UPDATE = 'Update this Host to pin and mark lanes.'
/** No `routines` capability: an older Host, or a grant without it, so neither "yet" nor "update". */

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

export interface RemoteLaneActionState {
  lane: HostLaneView
  host: Pick<HostConnectionView, 'capabilities' | 'laneMarks'> | undefined
  /** The Host is connected and ready for actions. */
  ready: boolean
  /** An action on this lane is in flight. */
  busy: boolean
  /** Why the Host would refuse Stop right now, if it would. */
  stopBlocked: string | null
  pr: { number: number } | null
  /** The marker preference: `off` drops the marker slot and its menu item, as on This Mac. */
  markers: LanePrefs['markers']
}

export interface RemoteLaneActionHandlers {
  /** Absent where the surface already is the lane (the phone's own lane sheet). */
  open?: () => void
  openPullRequest: () => void
  rename: () => void
  takeControl: () => void
  releaseControl: () => void
  stop: () => void
  resume: () => void
  markRead: () => void
  makeRoutine: () => void
  togglePin: () => void
  pickMarker: () => void
  exportHtml: () => void
  copyDebugInfo: () => void
  copySpend: () => void
  delete: () => void
}

/** What this client may do to the lane, and why not. One rule for every surface. */
export function remoteLaneAccess({ lane, host, ready }: RemoteLaneActionState) {
  const canControl = !!host?.capabilities.includes('sessions.control')
  const self = lane.control.controller?.self === true
  return {
    controlled: ready && canControl && self,
    running: lane.activity !== 'stopped' && lane.activity !== 'failed',
    canWrite: !!host?.capabilities.includes('workspaces.write'),
    canMark: ready && host?.laneMarks === true && canControl,
    controlHint: remoteControlHint(ready, canControl, self),
    markHint: !ready
      ? REMOTE_NOT_READY
      : host?.laneMarks !== true
        ? LANE_MARKS_NEED_UPDATE
        : !canControl
          ? REMOTE_UNAVAILABLE
          : undefined,
  }
}

/**
 * A Host lane's menu: the same items, order, enablement and hints on every
 * surface (Desktop sidebar, browser lists, Host home, the phone lane sheet).
 * Surfaces differ only in how they present the list.
 */
export function remoteLaneActions(
  state: RemoteLaneActionState,
  handlers: RemoteLaneActionHandlers,
  /** Move up and Move down, where the row sits in an ordered list (`SessionList`). */
  order: ContextMenuItem[] = [],
): ContextMenuItem[] {
  const { lane, ready, busy, stopBlocked, pr } = state
  const { controlled, running, canWrite, controlHint } = remoteLaneAccess(state)
  const self = lane.control.controller?.self === true
  const notReady = !ready ? REMOTE_NOT_READY : undefined
  const items: ContextMenuItem[] = []
  if (pr)
    items.push({ label: `Open pull request #${pr.number}`, onClick: handlers.openPullRequest })
  if (handlers.open)
    items.push({ label: 'Open', disabled: !ready || busy, hint: notReady, onClick: handlers.open })
  items.push(...order)
  items.push({
    label: 'Rename',
    disabled: !controlled || !running || busy,
    hint: controlHint ?? (!running ? ONLY_WHILE_RUNNING : undefined),
    onClick: handlers.rename,
  })
  items.push(
    self
      ? {
          label: 'Release control',
          disabled: !controlled || busy,
          hint: controlHint,
          onClick: handlers.releaseControl,
        }
      : {
          label: 'Take control',
          disabled: !ready || !state.host?.capabilities.includes('sessions.control') || busy,
          hint: notReady,
          onClick: handlers.takeControl,
        },
  )
  const blocked = running ? stopBlocked : null
  items.push(
    {
      label: running ? 'Stop' : 'Resume',
      disabled: !controlled || busy || !!blocked,
      hint: controlHint ?? blocked ?? undefined,
      onClick: running ? handlers.stop : handlers.resume,
    },
    {
      label: 'Mark read',
      disabled: !ready || busy,
      hint: notReady,
      onClick: handlers.markRead,
    },
    ...keepActions(state, handlers),
    {
      label: 'Delete',
      danger: true,
      separatorAbove: true,
      disabled: !controlled || !canWrite || busy,
      hint: controlHint ?? (!canWrite ? REMOTE_UNAVAILABLE : undefined),
      onClick: handlers.delete,
    },
  )
  return items
}

/** What a reader may keep or curate: a routine, pin and marker, an export and copies. */
function keepActions(
  state: RemoteLaneActionState,
  handlers: RemoteLaneActionHandlers,
): ContextMenuItem[] {
  const { lane, ready, busy } = state
  const { running, canMark, markHint } = remoteLaneAccess(state)
  const notReady = !ready ? REMOTE_NOT_READY : undefined
  // The lane's own readiness gates first; the capability alone says whether routines exist here.
  const noRoutines = state.host?.capabilities.includes('routines')
    ? undefined
    : featureNotOffered('routines')
  return [
    {
      label: 'Make routine…',
      disabled: !ready || busy || noRoutines !== undefined,
      hint: notReady ?? noRoutines,
      onClick: handlers.makeRoutine,
    },
    {
      label: lane.pinned ? 'Unpin' : 'Pin',
      disabled: !canMark,
      hint: markHint,
      onClick: handlers.togglePin,
    },
    ...(state.markers === 'off'
      ? []
      : [
          {
            label: 'Lane marker',
            disabled: !canMark,
            hint: markHint,
            onClick: handlers.pickMarker,
          },
        ]),
    // A read: any reader of the lane may keep a copy, as with Copy debug info.
    {
      label: 'Export HTML…',
      disabled: !ready || busy,
      hint: notReady,
      onClick: handlers.exportHtml,
    },
    { label: 'Copy debug info', onClick: handlers.copyDebugInfo },
    {
      label: 'Copy spend',
      disabled: !ready || busy || !running,
      hint: notReady ?? (!running ? ONLY_WHILE_RUNNING : undefined),
      onClick: handlers.copySpend,
    },
  ]
}
