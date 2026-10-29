/** Lane state as the Host protocol carries it: cursors, summaries, snapshots and events. */
import type { SessionPush } from '../models'
import type { AgentMessage, ExtensionUIRequest, PiEvent, RpcSessionState } from '../rpc'

/** Last event held, or seq 0 when none. A different `epoch` means take a snapshot. */
export interface StreamCursor {
  readonly epoch: string
  readonly seq: number
}

export interface RepositorySummary {
  /** 16 hex: the first 64 bits of SHA-256 over the folder's realpath. */
  readonly id: string
  readonly name: string
  /** Absolute on the Host. Display and scoping only, never an identity. */
  readonly path: string
}

export interface LaneController {
  readonly clientId: string
  readonly label: string
  /** False while the controller's socket is gone; it stays controller. */
  readonly connected: boolean
}

export interface LaneControl {
  /** Persisted; strictly increases on every controller change; never resets. */
  readonly fence: number
  readonly controller: LaneController | null
}

/**
 * - `stopped`: no pi process; the lane can be resumed.
 * - `idle`: live, waiting for a prompt.
 * - `working`: a turn, compaction or retry is running.
 * - `needs-input`: an extension dialog is open.
 * - `failed`: pi exited unexpectedly.
 */
export type LaneActivity = 'stopped' | 'idle' | 'working' | 'needs-input' | 'failed'

export interface LaneSummary {
  readonly laneId: string
  readonly repositoryId: string
  /** Absolute on the Host (a worktree lane's own folder). Never an identity. */
  readonly cwd: string
  readonly title: string | null
  readonly branch: string | null
  readonly worktree: boolean
  readonly model: { readonly provider: string; readonly id: string } | null
  readonly activity: LaneActivity
  readonly createdAt: string
  readonly updatedAt: string
  /** Persisted counter of attention-worthy outcomes. Unread while `attention > read`. */
  readonly attention: number
  readonly read: number
  readonly control: LaneControl
  /** Pinned on the Host. Absent when not pinned. */
  readonly pinned?: true
  /** An explicit marker choice; '' is "no marker" on purpose. Absent: the derived auto marker. */
  readonly marker?: string
}

/** One consistent view of a lane at `(epoch, seq)`; events continue from `seq + 1`. */
export interface LaneSnapshot {
  readonly cursor: StreamCursor
  readonly summary: LaneSummary
  /** pi's `get_state` while live; null when stopped or failed. */
  readonly state: RpcSessionState | null
  /** pi's settled messages, as `get_messages` returns them. */
  readonly messages: readonly AgentMessage[]
  /** Raw pi events after the last settled message: the turn in flight. */
  readonly pending: readonly PiEvent[]
  /** Extension dialogs still open. Only the controller's answer is admitted. */
  readonly dialogs: readonly ExtensionUIRequest[]
  /** Latest fire-and-forget UI state: the last setStatus per statusKey, the last setWidget per widgetKey, the last setTitle. Never notify or set_editor_text, which are moments, not state. */
  readonly ui: readonly ExtensionUIRequest[]
}

/** `stderr` never crosses the wire: it can hold paths and environment. */
export type LanePiPush = Exclude<SessionPush, { kind: 'stderr' | 'resync' }>

export type LaneEvent =
  | { readonly kind: 'pi'; readonly push: LanePiPush }
  | { readonly kind: 'control'; readonly control: LaneControl }
  | { readonly kind: 'summary'; readonly summary: LaneSummary }
  | { readonly kind: 'dialog-resolved'; readonly dialogId: string }

export type AttentionKind =
  'finished' | 'needs-input' | 'failed' | 'routine-finished' | 'routine-paused'

export interface AttentionEvent {
  /** `${laneId}:${attention}`: the same outcome has the same id on every surface. */
  readonly id: string
  readonly laneId: string
  readonly kind: AttentionKind
  /** The lane's attention counter after this outcome. */
  readonly attention: number
  readonly at: string
  readonly title: string | null
}
