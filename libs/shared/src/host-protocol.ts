/**
 * Host protocol v1: the only language Desktop (and later the PWA) speaks to a
 * Host, over one WebSocket per client per Host, reached through Tailscale.
 *
 * The machine that runs a lane is its single ordering point. Every mutation is
 * a `command` with a client request id, admitted against the lane's control
 * fence and answered by exactly one durable receipt. Every change a viewer can
 * see arrives as an ordered `event` in that lane's stream, so all viewers flip
 * state at the same point (requirement R7).
 *
 * Pure module: no Node or DOM imports. Living contract: docs/remote-access.md
 * ("Host protocol").
 */
import type { SessionPush } from './models'
import { HOST_PROTOCOL_VERSION, type HostCapability, type HostHello } from './remote-host'
import type {
  AgentMessage,
  ExtensionUIRequest,
  ExtensionUIResponse,
  PiEvent,
  RpcCommand,
  RpcSessionState,
} from './rpc'

export { HOST_PROTOCOL_VERSION }

/** Loopback port the Host API listens on; `tailscale serve` exposes the same HTTPS port. */
export const HOST_API_PORT = 47615

export const HOST_API_ROUTES = {
  /** GET, unauthenticated: hello plus a proof over the caller's challenge. */
  hello: '/v1/hello',
  /** GET, WebSocket upgrade. Everything else is a frame on this socket. */
  stream: '/v1/stream',
} as const

/** Upper bounds. A brief may lower these, never raise them. */
export const HOST_LIMITS = {
  /** Client to Host, UTF-8 bytes. Prompts with images need the room. */
  inboundFrameBytes: 8 * 1024 * 1024,
  /** Host to client, UTF-8 bytes. A larger snapshot is a protocol error on the Host. */
  outboundFrameBytes: 16 * 1024 * 1024,
  /** The first frame must be `auth` within this. */
  authTimeoutMs: 10_000,
  /** A grant lives at most this long (`exp - iat`). */
  grantTtlSec: 300,
  /** Clients renew this long before `grantExpiresAt`. */
  renewBeforeSec: 60,
  pingIntervalMs: 20_000,
  /** No frame from the client for this long closes the socket. */
  idleCloseMs: 60_000,
  subscriptionsPerConnection: 64,
  connectionsPerClient: 4,
  /** Commands admitted but not yet answered, per connection. */
  pendingCommandsPerConnection: 32,
  /** Per lane: events kept for replay, by count and by bytes. */
  replayEvents: 2000,
  replayBytes: 8 * 1024 * 1024,
  /** Per connection: queued outbound bytes before a lane is reset to a snapshot. */
  sendQueueBytes: 32 * 1024 * 1024,
  /** Events in a snapshot's `pending` (the turn in flight). */
  pendingEvents: 4000,
  receiptsKept: 10_000,
  receiptTtlMs: 24 * 60 * 60 * 1000,
  /** A receipt's stored `data`, UTF-8 bytes of its JSON. Larger data is dropped, not truncated. */
  receiptDataBytes: 256 * 1024,
  lanesPerHost: 1000,
  repositoriesPerHost: 64,
  /** Attention events kept per Host for replay to a returning client. */
  attentionReplay: 200,
  /** Labels a client chooses: lane titles, client labels. */
  labelChars: 80,
  /** Free-text error messages forwarded to clients. */
  messageChars: 2000,
  /** Frame ids, subscription ids and call ids. */
  idChars: 64,
} as const

/** WebSocket close codes. 1001 is the standard "going away" (Host stopping). */
export const HOST_CLOSE = {
  goingAway: 1001,
  badFrame: 4400,
  unauthenticated: 4401,
  forbidden: 4403,
  unsupportedProtocol: 4409,
  tooMany: 4429,
} as const
export type HostCloseCode = (typeof HOST_CLOSE)[keyof typeof HOST_CLOSE]

/**
 * What the Host signs to prove it is the enrolled machine. The client sends a
 * fresh 32-byte challenge (64 lowercase hex) and verifies the signature with
 * the Host public key the grant broker returned with its grant.
 */
export function helloProofMessage(hostId: string, runtimeEpoch: string, challenge: string): string {
  return `phosphor-host-hello/v1\n${hostId}\n${runtimeEpoch}\n${challenge}`
}

// ---------- lanes ----------

/** Position in one lane's stream. A different `epoch` means take a snapshot. */
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
}

/** `stderr` never crosses the wire: it can hold paths and environment. */
export type LanePiPush = Exclude<SessionPush, { kind: 'stderr' }>

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

// ---------- commands and receipts ----------

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
] as const
export type LanePiOpType = (typeof LANE_PI_OPS)[number]
/** pi's own command shapes, without pi's correlation id (the Host assigns it). */
export type LanePiOp = Omit<Extract<RpcCommand, { type: LanePiOpType }>, 'id'>

export type LaneOp =
  | LanePiOp
  | { readonly type: 'extension_ui_response'; readonly response: ExtensionUIResponse }
  | {
      readonly type: 'lane.create'
      readonly repositoryId: string
      /** null: run in the repository itself. A branch: a new worktree lane on it. */
      readonly worktree: { readonly branch: string } | null
      readonly name?: string
      readonly provider?: string
      readonly model?: string
      readonly thinkingLevel?: string
    }
  | { readonly type: 'lane.resume' }
  | { readonly type: 'lane.stop' }
  | { readonly type: 'lane.markRead'; readonly upTo: number }
  | { readonly type: 'control.take' }
  | { readonly type: 'control.release' }

export type LaneOpType = LaneOp['type']

/** Ops admitted without a matching fence. Every other lane op needs one. */
export const UNFENCED_OPS: readonly LaneOpType[] = ['lane.create', 'lane.markRead', 'control.take']

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
  /** The Host restarted between recording the request and finishing it. */
  | { readonly requestId: string; readonly status: 'unknown' }

// ---------- queries ----------

/** Read-only, idempotent, no receipt. M3 features add namespaced methods in their own modules. */
export const HOST_CALL_METHODS = [
  'host.repositories',
  'lane.state',
  'lane.messages',
  'lane.stats',
  'lane.models',
  'lane.commands',
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

// ---------- frames ----------

export type ClientFrame =
  /** First frame (with `challenge`), and later to renew (without). */
  | { readonly type: 'auth'; readonly grant: string; readonly challenge?: string }
  | {
      readonly type: 'subscribe'
      readonly id: string
      readonly topic: 'lanes'
      /** Replays attention events after this cursor when the epoch matches. */
      readonly after?: StreamCursor
      readonly trace?: string
    }
  | {
      readonly type: 'subscribe'
      readonly id: string
      readonly topic: 'lane'
      readonly laneId: string
      readonly after?: StreamCursor
      readonly trace?: string
    }
  | { readonly type: 'unsubscribe'; readonly id: string }
  | {
      readonly type: 'command'
      readonly requestId: string
      readonly laneId?: string
      readonly fence?: number
      readonly op: LaneOp
      readonly trace?: string
    }
  | { readonly type: 'receipt-status'; readonly requestId: string }
  | {
      readonly type: 'call'
      readonly id: string
      readonly method: string
      readonly params?: unknown
      readonly trace?: string
    }
  | { readonly type: 'ping'; readonly at: number }

export type HostFrame =
  | {
      readonly type: 'ready'
      readonly protocolVersion: typeof HOST_PROTOCOL_VERSION
      readonly hello: HostHello
      /** base64url Ed25519 over `helloProofMessage(hostId, runtimeEpoch, challenge)`. */
      readonly proof: string
      readonly connectionId: string
      readonly grantExpiresAt: string
      readonly client: { readonly id: string; readonly label: string }
      /** Effective capabilities for this connection. */
      readonly capabilities: readonly HostCapability[]
    }
  | { readonly type: 'auth-renewed'; readonly grantExpiresAt: string }
  | {
      readonly type: 'lanes'
      readonly id: string
      readonly cursor: StreamCursor
      readonly repositories: readonly RepositorySummary[]
      readonly lanes: readonly LaneSummary[]
    }
  | {
      readonly type: 'lanes-delta'
      readonly id: string
      readonly cursor: StreamCursor
      readonly upsert: readonly LaneSummary[]
      readonly remove: readonly string[]
    }
  | {
      readonly type: 'attention'
      readonly id: string
      readonly cursor: StreamCursor
      readonly event: AttentionEvent
    }
  | {
      readonly type: 'snapshot'
      readonly id: string
      readonly laneId: string
      /** True when it replaces state the client already had. */
      readonly reset: boolean
      readonly snapshot: LaneSnapshot
    }
  | {
      readonly type: 'event'
      readonly id: string
      readonly laneId: string
      readonly cursor: StreamCursor
      readonly event: LaneEvent
    }
  | {
      readonly type: 'subscribe-failed'
      readonly id: string
      readonly code: 'unknown-lane' | 'too-many' | 'forbidden' | 'bad-request'
    }
  | { readonly type: 'receipt'; readonly receipt: Receipt }
  | { readonly type: 'result'; readonly id: string; readonly ok: true; readonly data: unknown }
  | { readonly type: 'result'; readonly id: string; readonly ok: false; readonly error: CallError }
  /** Sent just before the Host closes the socket with a 44xx code. */
  | { readonly type: 'error'; readonly code: HostCloseCode; readonly message: string }
  | { readonly type: 'pong'; readonly at: number }

// ---------- parsers (wave 0 kit) ----------
// parseClientFrame / parseHostFrame and their helpers go below this line.
