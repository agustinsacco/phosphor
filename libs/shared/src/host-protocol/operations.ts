/** Commands and their receipts, read-only queries, and the capability each admits. */
import type { AttachmentOp } from '../host-protocol-attachments'
import type { ProviderLoginOp } from '../host-protocol-providers'
import type { MachineTaskOp } from '../machine-settings'
import type { LaneMarksOp } from '../host-protocol-lane-marks'
import type { DeleteLaneOp, RepositoryOp } from '../host-protocol-repositories'
import type { RoutineOp } from '../host-protocol-routines'
import type { TerminalOp } from '../host-protocol-terminals'
import type { FileWriteOp } from '../host-protocol-writes'
import type { HostCapability } from '../remote-host'
import type { ExtensionUIResponse, RpcCommand } from '../rpc'
import type { LaneControl } from './lanes'

/** pi operations a remote client may ask for. Everything else is refused. */
export const LANE_PI_OPS = [
  'prompt',
  'steer',
  'follow_up',
  'abort',
  'abort_retry',
  'set_model',
  'set_thinking_level',
  'compact',
  'set_session_name',
  'clear_queue',
  'set_steering_mode',
  'set_follow_up_mode',
  'set_auto_compaction',
  'set_auto_retry',
  'bash',
  'abort_bash',
] as const
export type LanePiOpType = (typeof LANE_PI_OPS)[number]
const PI_OPS: ReadonlySet<string> = new Set(LANE_PI_OPS)
/**
 * A command or op whose type is in LANE_PI_OPS. The client forwards exactly
 * these to a Host and the Host passes exactly these to pi, so a new pi command
 * is allowed in one place.
 */
export function isLanePiOp<T extends { type: string }>(
  v: T,
): v is Extract<T, { type: LanePiOpType }> {
  return PI_OPS.has(v.type)
}
/** pi's own command shapes, without pi's correlation id (the Host assigns it). */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never
export type LanePiOp = DistributiveOmit<Extract<RpcCommand, { type: LanePiOpType }>, 'id'>

export type LaneOp =
  | RepositoryOp
  | DeleteLaneOp
  | LaneMarksOp
  | ProviderLoginOp
  | MachineTaskOp
  | TerminalOp
  | RoutineOp
  | FileWriteOp
  | AttachmentOp
  | LanePiOp
  | { readonly type: 'extension_ui_response'; readonly response: ExtensionUIResponse }
  | {
      readonly type: 'lane.create'
      readonly repositoryId: string
      /** null: run in the repository itself. A branch: a new worktree lane on it. */
      readonly worktree: {
        readonly branch: string
        /** New-only ref creation; older Hosts ignore this additive field. */
        readonly fresh?: true
      } | null
      readonly name?: string
      readonly provider?: string
      readonly model?: string
      readonly thinkingLevel?: string
    }
  | { readonly type: 'claude.account'; readonly accountId: string }
  | { readonly type: 'lane.resume' }
  | { readonly type: 'lane.stop' }
  | { readonly type: 'lane.markRead'; readonly upTo: number }
  | { readonly type: 'control.take' }
  | { readonly type: 'control.release' }

export type LaneOpType = LaneOp['type']

/** Ops admitted without a matching fence. Every other lane op needs one. */
export const UNFENCED_OPS: readonly LaneOpType[] = [
  'lane.create',
  'lane.markRead',
  'control.take',
  'host.repositories.add',
  'host.repositories.remove',
  'host.repositories.createFolder',
  'host.repositories.order',
  'lane.marks',
]

export type RejectCode =
  | 'bad-request'
  | 'unsupported'
  | 'forbidden'
  | 'unknown-lane'
  | 'lane-stopped'
  | 'not-controller'
  | 'stale-fence'
  /** The request id was already used for another op or by another client. */
  | 'conflict'
  | 'busy'
  | 'branch-exists'
  | 'last-repository'
  | 'too-many-requests'

export type FailureCode = 'pi-error' | 'timeout' | 'internal'

export type Receipt =
  | { readonly requestId: string; readonly status: 'pending' }
  | {
      readonly requestId: string
      readonly status: 'done'
      /** pi's response data, or the op's own result. Dropped when over the size limit. */
      readonly data?: unknown
      /** The lane's fence after the op, when the op changed or checked it. */
      readonly fence?: number
      /** Set by `lane.create`. */
      readonly laneId?: string
    }
  | {
      readonly requestId: string
      readonly status: 'failed'
      readonly error: { readonly code: FailureCode; readonly message: string }
    }
  | {
      readonly requestId: string
      readonly status: 'rejected'
      readonly code: RejectCode
      /** For `not-controller` and `stale-fence`: who controls the lane now. */
      readonly control?: LaneControl
    }
  /** The Host cannot say whether the op took effect, after a restart or no pi answer. */
  | { readonly requestId: string; readonly status: 'unknown' }

// ---------- queries ----------

/** Read-only, idempotent, no receipt. M3 features add namespaced methods in their own modules. */
export const HOST_CALL_METHODS = [
  'host.repositories',
  'lane.state',
  'lane.messages',
  'lane.receipt',
  'lane.stats',
  'lane.models',
  'lane.commands',
  'lane.exportHtml',
] as const
export type HostCallMethod = (typeof HOST_CALL_METHODS)[number]

export type CallErrorCode =
  | 'bad-request'
  | 'unsupported'
  | 'forbidden'
  | 'unknown-lane'
  | 'lane-stopped'
  | 'too-large'
  | 'internal'

export interface CallError {
  readonly code: CallErrorCode
  readonly message: string
}

/** What each capability admits. Effective capabilities = the grant's ∩ the Host's. */
export const CAPABILITY_FOR = {
  subscribeLanes: 'sessions.read',
  subscribeLane: 'sessions.read',
  call: 'sessions.read',
  command: 'sessions.control',
} as const satisfies Record<string, HostCapability>
