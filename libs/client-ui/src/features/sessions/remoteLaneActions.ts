import { featureNotOffered } from '@/stores/hostRefusals'
import type { MachineCaps } from '@/stores/machineCaps'
import { REMOTE_NOT_READY } from '@/stores/remoteLanes'
import type { HostLaneView } from '@shared/ipc'
import type { LanePrefs } from '@shared/models'
import type { LaneActionContext } from './laneActions'

export const TAKE_CONTROL_FIRST = 'Take control first.'
export const ONLY_WHILE_RUNNING = 'Only while running.'
/** A Host older than `laneMarks` cannot keep pins or markers, and only that Host can. */
export const LANE_MARKS_NEED_UPDATE = 'Update this Host to pin and mark lanes.'
export const LANE_MOVE_NEEDS_UPDATE = 'Update this Host to move lanes.'
/** A move copies the saved transcript, so a lane mid-turn waits; an idle one is stopped first. */
export const WAIT_BEFORE_MOVE = 'Wait for this lane to finish working.'
export const MOVE_STOPS_LANE = 'stops it first'

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
  if (!canControl) return featureNotOffered('sessions.control')
  return self ? undefined : TAKE_CONTROL_FIRST
}

export interface RemoteLaneActionState {
  lane: HostLaneView
  caps: MachineCaps
  /** The Host is connected and ready for actions. */
  ready: boolean
  /** An action on this lane is in flight. */
  busy: boolean
  /** Why the Host would refuse Stop right now, if it would. */
  stopBlocked: string | null
  pr: { number: number; state?: string } | null
  /** The marker preference: `off` drops the marker slot and its menu item, as on This Mac. */
  markers: LanePrefs['markers']
  /** Desktop relays bundles; the browser cannot. */
  moveBlocked?: string
}

/** What this client may do to the lane, and why not. One rule for every surface. */
export function remoteLaneAccess({ lane, caps, ready }: RemoteLaneActionState) {
  const canControl = caps.granted('sessions.control')
  const self = lane.control.controller?.self === true
  return {
    controlled: ready && canControl && self,
    running: lane.activity !== 'stopped' && lane.activity !== 'failed',
    canWrite: caps.granted('workspaces.write'),
    canMark: ready && caps.laneMarks && canControl,
    controlHint: remoteControlHint(ready, canControl, self),
    markHint: !ready
      ? REMOTE_NOT_READY
      : !caps.laneMarks
        ? LANE_MARKS_NEED_UPDATE
        : !canControl
          ? featureNotOffered('sessions.control')
          : undefined,
  }
}

/**
 * A Host lane's menu context: the same items, order, enablement and hints on
 * every surface (Desktop sidebar, browser lists, Host home, the phone lane
 * sheet). Surfaces differ only in how they present the list.
 */
export function hostLaneContext(state: RemoteLaneActionState): LaneActionContext {
  const { lane, caps, ready, stopBlocked } = state
  const { running, canWrite, controlHint, markHint } = remoteLaneAccess(state)
  const self = lane.control.controller?.self === true
  const notReady = ready ? undefined : REMOTE_NOT_READY
  const whileRunning = running ? undefined : ONLY_WHILE_RUNNING
  const noControl = caps.granted('sessions.control')
    ? undefined
    : featureNotOffered('sessions.control')
  return {
    pinned: lane.pinned === true,
    markers: state.markers,
    pr: state.pr,
    unseen: lane.attention > lane.read,
    running,
    spend: {},
    control: { self },
    busy: state.busy,
    refusals: {
      open: notReady,
      rename: controlHint ?? whileRunning,
      // The lane's own readiness gates first; the capability alone says whether routines exist here.
      makeRoutine:
        notReady ?? (caps.granted('routines') ? undefined : featureNotOffered('routines')),
      pin: markHint,
      marker: markHint,
      control: self ? controlHint : (notReady ?? noControl),
      stop: controlHint ?? stopBlocked ?? undefined,
      resume: controlHint,
      markRead: notReady,
      // A read: any reader of the lane may keep a copy, as with Copy debug info.
      exportHtml: notReady,
      moveTo: notReady ?? moveHint(state, running, controlHint),
      copySpend: notReady ?? whileRunning,
      delete: controlHint ?? (canWrite ? undefined : featureNotOffered('workspaces.write')),
    },
    hints: { moveTo: running ? MOVE_STOPS_LANE : undefined },
  }
}

/** Why a saved Host lane cannot be copied from this client right now. */
function moveHint(
  state: RemoteLaneActionState,
  running: boolean,
  controlHint: string | undefined,
): string | undefined {
  if (state.moveBlocked) return state.moveBlocked
  if (!state.caps.laneTransfer) return LANE_MOVE_NEEDS_UPDATE
  if (!state.caps.granted('sessions.control')) return featureNotOffered('sessions.control')
  if (!running) return undefined
  const { activity } = state.lane
  if (activity === 'working' || activity === 'needs-input') return WAIT_BEFORE_MOVE
  // Moving stops the idle session first, which Stop's own rules govern.
  return controlHint ?? state.stopBlocked ?? undefined
}
