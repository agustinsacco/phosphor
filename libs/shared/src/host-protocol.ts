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
import { isUuid, isControlTrace, isIsoTime, normalizeLabel, type Parsed } from './control-api'
import { GRANT_LIMITS } from './host-grant'
import { HOST_CAPABILITIES, validateHostHello } from './remote-host'
import type { SessionPush } from './models'
import { HOST_PROTOCOL_VERSION, type HostCapability, type HostHello } from './remote-host'
import type {
  AgentMessage,
  ExtensionUIRequest,
  ExtensionUIResponse,
  ImageContent,
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
  /** Host to client, UTF-8 bytes. Oversize subscriptions fail with too-large. */
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
  uiStatusKeys: 64,
  uiWidgetKeys: 32,
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
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never
export type LanePiOp = DistributiveOmit<Extract<RpcCommand, { type: LanePiOpType }>, 'id'>

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
      readonly code: 'unknown-lane' | 'too-many' | 'forbidden' | 'bad-request' | 'too-large'
    }
  | { readonly type: 'receipt'; readonly receipt: Receipt }
  | { readonly type: 'result'; readonly id: string; readonly ok: true; readonly data: unknown }
  | { readonly type: 'result'; readonly id: string; readonly ok: false; readonly error: CallError }
  /** Sent just before the Host closes the socket with a 44xx code. */
  | { readonly type: 'error'; readonly code: HostCloseCode; readonly message: string }
  | { readonly type: 'pong'; readonly at: number }

// ---------- parsers (wave 0 kit) ----------
// parseClientFrame / parseHostFrame and their helpers go below this line.

export interface FrameSocket {
  send(text: string): void
  close(code: number, reason: string): void
  onMessage(cb: (text: string) => void): void
  onClose(cb: (code: number, reason: string) => void): void
  isOpen(): boolean
  bufferedBytes(): number
}

export type ClientFrameParse =
  | { ok: true; frame: ClientFrame }
  | {
      ok: false
      reason: string
      reply?:
        | { kind: 'receipt'; requestId: string; code: 'unsupported' | 'bad-request' }
        | { kind: 'result'; id: string; code: 'bad-request' }
    }

/** Counts UTF-8 bytes, including replacement characters for unpaired surrogates. */
export function utf8Length(text: string): number {
  let bytes = 0
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c < 0x80) bytes++
    else if (c < 0x800) bytes += 2
    else if (
      c >= 0xd800 &&
      c <= 0xdbff &&
      text.charCodeAt(i + 1) >= 0xdc00 &&
      text.charCodeAt(i + 1) <= 0xdfff
    ) {
      bytes += 4
      i++
    } else bytes += 3
  }
  return bytes
}

function record(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}
function text(v: unknown, max: number, min = 1): v is string {
  return typeof v === 'string' && v.length >= min && v.length <= max
}
function member<T extends string>(v: unknown, choices: readonly T[]): v is T {
  return typeof v === 'string' && choices.some((c) => c === v)
}
function integer(v: unknown, min = 0): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= min
}
function hex(v: unknown): v is string {
  return typeof v === 'string' && /^[0-9a-f]{16}$/.test(v)
}
function frameId(v: unknown): v is string {
  return typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v)
}
function label(v: unknown): v is string {
  return typeof v === 'string' && normalizeLabel(v) === v
}
function cursor(v: unknown, min = 0): StreamCursor | null {
  return record(v) && hex(v.epoch) && integer(v.seq, min) ? { epoch: v.epoch, seq: v.seq } : null
}
function readJson(s: string, limit: number): Parsed<Record<string, unknown>> {
  if (utf8Length(s) > limit) return { ok: false, reason: 'frame-size' }
  try {
    const v: unknown = JSON.parse(s)
    return record(v) ? { ok: true, value: v } : { ok: false, reason: 'object' }
  } catch {
    return { ok: false, reason: 'json' }
  }
}

/** Wire guard for a git branch. Non-ASCII is refused; git checks it again on the Host. */
export function isLaneBranchName(v: unknown): v is string {
  return (
    text(v, 200) &&
    /^[!-~]+$/.test(v) &&
    !/[~^:?*[\\]/.test(v) &&
    !v.includes('..') &&
    !v.includes('@{') &&
    v !== '@' &&
    !v.startsWith('-') &&
    !v.startsWith('/') &&
    !v.endsWith('/') &&
    !v.includes('//') &&
    !v.endsWith('.') &&
    v.split('/').every((s) => !s.startsWith('.') && !s.endsWith('.lock'))
  )
}

const thinking = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
function imageData(v: unknown): v is string {
  // Avoid a repeated-group regex: multi-megabyte images can exhaust the regex stack.
  if (!text(v, HOST_LIMITS.inboundFrameBytes) || v.length % 4 !== 0) return false
  const unpadded = v.endsWith('==') ? v.slice(0, -2) : v.endsWith('=') ? v.slice(0, -1) : v
  return /^[A-Za-z0-9+/]+$/.test(unpadded)
}
function images(v: unknown): ImageContent[] | null {
  if (!Array.isArray(v) || v.length > 16) return null
  const out: ImageContent[] = []
  for (const item of v) {
    if (
      !record(item) ||
      item.type !== 'image' ||
      !imageData(item.data) ||
      !member(item.mimeType, ['image/png', 'image/jpeg', 'image/gif', 'image/webp'])
    )
      return null
    out.push({ type: 'image', data: item.data, mimeType: item.mimeType })
  }
  return out
}
function response(v: unknown): ExtensionUIResponse | null {
  if (!record(v) || v.type !== 'extension_ui_response' || !frameId(v.id)) return null
  const count = ['value', 'confirmed', 'cancelled'].filter((k) => k in v).length
  if (count !== 1) return null
  if (typeof v.value === 'string') return { type: v.type, id: v.id, value: v.value }
  if (typeof v.confirmed === 'boolean') return { type: v.type, id: v.id, confirmed: v.confirmed }
  return v.cancelled === true ? { type: v.type, id: v.id, cancelled: true } : null
}
function op(v: unknown): LaneOp | null {
  if (!record(v)) return null
  switch (v.type) {
    case 'prompt':
    case 'steer':
    case 'follow_up': {
      if (!text(v.message, HOST_LIMITS.inboundFrameBytes)) return null
      const img = v.images === undefined ? undefined : images(v.images)
      if (img === null) return null
      if (v.type === 'prompt') {
        if (
          v.streamingBehavior !== undefined &&
          !member(v.streamingBehavior, ['steer', 'followUp'])
        )
          return null
        return {
          type: v.type,
          message: v.message,
          ...(img ? { images: img } : {}),
          ...(v.streamingBehavior !== undefined ? { streamingBehavior: v.streamingBehavior } : {}),
        }
      }
      return { type: v.type, message: v.message, ...(img ? { images: img } : {}) }
    }
    case 'abort':
    case 'abort_retry':
    case 'lane.resume':
    case 'lane.stop':
    case 'control.take':
    case 'control.release':
      return { type: v.type }
    case 'set_model':
      return text(v.provider, 200) && text(v.modelId, 200)
        ? { type: v.type, provider: v.provider, modelId: v.modelId }
        : null
    case 'set_thinking_level':
      return member(v.level, thinking) ? { type: v.type, level: v.level } : null
    case 'compact':
      return v.customInstructions === undefined
        ? { type: v.type }
        : text(v.customInstructions, HOST_LIMITS.inboundFrameBytes)
          ? { type: v.type, customInstructions: v.customInstructions }
          : null
    case 'set_session_name':
      return label(v.name) ? { type: v.type, name: v.name } : null
    case 'extension_ui_response': {
      const r = response(v.response)
      return r ? { type: v.type, response: r } : null
    }
    case 'lane.markRead':
      return integer(v.upTo) ? { type: v.type, upTo: v.upTo } : null
    case 'lane.create': {
      if (
        !hex(v.repositoryId) ||
        (v.worktree !== null && (!record(v.worktree) || !isLaneBranchName(v.worktree.branch))) ||
        (v.name !== undefined && !label(v.name)) ||
        (v.provider !== undefined && !text(v.provider, 200)) ||
        (v.model !== undefined && !text(v.model, 200)) ||
        (v.thinkingLevel !== undefined && !member(v.thinkingLevel, thinking))
      )
        return null
      return {
        type: v.type,
        repositoryId: v.repositoryId,
        worktree:
          record(v.worktree) && isLaneBranchName(v.worktree.branch)
            ? { branch: v.worktree.branch }
            : null,
        ...(v.name !== undefined ? { name: v.name } : {}),
        ...(v.provider !== undefined ? { provider: v.provider } : {}),
        ...(v.model !== undefined ? { model: v.model } : {}),
        ...(v.thinkingLevel !== undefined ? { thinkingLevel: v.thinkingLevel } : {}),
      }
    }
    default:
      return null
  }
}
const laneOps = [
  ...LANE_PI_OPS,
  'extension_ui_response',
  'lane.create',
  'lane.resume',
  'lane.stop',
  'lane.markRead',
  'control.take',
  'control.release',
] as const

export function parseClientFrame(s: string): ClientFrameParse {
  const parsed = readJson(s, HOST_LIMITS.inboundFrameBytes)
  if (!parsed.ok) return parsed
  const v = parsed.value
  const bad = (reason = 'frame'): ClientFrameParse => ({ ok: false, reason })
  const good = (frame: ClientFrame): ClientFrameParse => ({ ok: true, frame })
  switch (v.type) {
    case 'auth':
      if (
        !text(v.grant, GRANT_LIMITS.tokenChars) ||
        (v.challenge !== undefined &&
          (typeof v.challenge !== 'string' || !/^[0-9a-f]{64}$/.test(v.challenge)))
      )
        return bad()
      return good({
        type: v.type,
        grant: v.grant,
        ...(v.challenge !== undefined ? { challenge: v.challenge } : {}),
      })
    case 'subscribe': {
      const after = v.after === undefined ? undefined : cursor(v.after)
      if (!frameId(v.id) || after === null || (v.trace !== undefined && !isControlTrace(v.trace)))
        return bad()
      const common = {
        id: v.id,
        ...(after ? { after } : {}),
        ...(v.trace !== undefined ? { trace: v.trace } : {}),
      }
      if (v.topic === 'lanes') return good({ type: v.type, topic: v.topic, ...common })
      if (v.topic === 'lane' && isUuid(v.laneId))
        return good({ type: v.type, topic: v.topic, laneId: v.laneId, ...common })
      return bad()
    }
    case 'unsubscribe':
      return frameId(v.id) ? good({ type: v.type, id: v.id }) : bad()
    case 'receipt-status':
      return isUuid(v.requestId) ? good({ type: v.type, requestId: v.requestId }) : bad()
    case 'ping':
      return integer(v.at) ? good({ type: v.type, at: v.at }) : bad()
    case 'command': {
      if (!isUuid(v.requestId)) return bad()
      const operation = op(v.op)
      if (
        !operation ||
        (v.laneId !== undefined && !isUuid(v.laneId)) ||
        (v.fence !== undefined && !integer(v.fence, 1)) ||
        (v.trace !== undefined && !isControlTrace(v.trace))
      ) {
        return {
          ok: false,
          reason: 'command',
          reply: {
            kind: 'receipt',
            requestId: v.requestId,
            code:
              record(v.op) && typeof v.op.type === 'string' && !member(v.op.type, laneOps)
                ? 'unsupported'
                : 'bad-request',
          },
        }
      }
      return good({
        type: v.type,
        requestId: v.requestId,
        op: operation,
        ...(v.laneId !== undefined ? { laneId: v.laneId } : {}),
        ...(v.fence !== undefined ? { fence: v.fence } : {}),
        ...(v.trace !== undefined ? { trace: v.trace } : {}),
      })
    }
    case 'call':
      if (!frameId(v.id)) return bad()
      if (
        !text(v.method, 64) ||
        !/^[a-z][A-Za-z0-9]*(\.[a-z][A-Za-z0-9]*){1,2}$/.test(v.method) ||
        (v.trace !== undefined && !isControlTrace(v.trace))
      )
        return {
          ok: false,
          reason: 'call',
          reply: { kind: 'result', id: v.id, code: 'bad-request' },
        }
      return good({
        type: v.type,
        id: v.id,
        method: v.method,
        ...(v.params !== undefined ? { params: v.params } : {}),
        ...(v.trace !== undefined ? { trace: v.trace } : {}),
      })
    default:
      return bad('type')
  }
}

function capabilities(v: unknown): v is HostCapability[] {
  return (
    Array.isArray(v) &&
    v.length <= HOST_CAPABILITIES.length &&
    v.every((x) => member(x, HOST_CAPABILITIES)) &&
    new Set(v).size === v.length
  )
}
function control(v: unknown): LaneControl | null {
  if (!record(v) || !integer(v.fence, 1)) return null
  if (v.controller === null) return { fence: v.fence, controller: null }
  const c = v.controller
  return record(c) && isUuid(c.clientId) && label(c.label) && typeof c.connected === 'boolean'
    ? {
        fence: v.fence,
        controller: { clientId: c.clientId, label: c.label, connected: c.connected },
      }
    : null
}
function summary(v: unknown): LaneSummary | null {
  if (!record(v)) return null
  const c = control(v.control)
  if (
    !isUuid(v.laneId) ||
    !hex(v.repositoryId) ||
    !text(v.cwd, HOST_LIMITS.outboundFrameBytes) ||
    (v.title !== null && !label(v.title)) ||
    (v.branch !== null && !isLaneBranchName(v.branch)) ||
    typeof v.worktree !== 'boolean' ||
    (v.model !== null &&
      (!record(v.model) || !text(v.model.provider, 200) || !text(v.model.id, 200))) ||
    !member(v.activity, ['stopped', 'idle', 'working', 'needs-input', 'failed']) ||
    !isIsoTime(v.createdAt) ||
    !isIsoTime(v.updatedAt) ||
    !integer(v.attention) ||
    !integer(v.read) ||
    v.read > v.attention ||
    !c
  )
    return null
  return {
    laneId: v.laneId,
    repositoryId: v.repositoryId,
    cwd: v.cwd,
    title: v.title,
    branch: v.branch,
    worktree: v.worktree,
    model:
      record(v.model) && text(v.model.provider, 200) && text(v.model.id, 200)
        ? { provider: v.model.provider, id: v.model.id }
        : null,
    activity: v.activity,
    createdAt: v.createdAt,
    updatedAt: v.updatedAt,
    attention: v.attention,
    read: v.read,
    control: c,
  }
}
function list<T>(v: unknown, max: number, parse: (item: unknown) => T | null): T[] | null {
  if (!Array.isArray(v) || v.length > max) return null
  const out: T[] = []
  for (const item of v) {
    const p = parse(item)
    if (p === null) return null
    out.push(p)
  }
  return out
}
function repository(v: unknown): RepositorySummary | null {
  return record(v) &&
    hex(v.id) &&
    text(v.name, HOST_LIMITS.outboundFrameBytes) &&
    text(v.path, HOST_LIMITS.outboundFrameBytes)
    ? { id: v.id, name: v.name, path: v.path }
    : null
}
// pi payloads are deliberately shallow: rpc.ts owns their evolving inner shapes.
function piEvent(v: unknown): v is PiEvent {
  return record(v) && typeof v.type === 'string'
}
function piMessage(v: unknown): v is AgentMessage {
  return record(v) && typeof v.role === 'string'
}
function piDialog(v: unknown): v is ExtensionUIRequest {
  return (
    record(v) && v.type === 'extension_ui_request' && frameId(v.id) && typeof v.method === 'string'
  )
}
function piUi(v: unknown): v is ExtensionUIRequest {
  return (
    piDialog(v) && (v.method === 'setStatus' || v.method === 'setWidget' || v.method === 'setTitle')
  )
}
function piState(v: unknown): v is RpcSessionState {
  return record(v)
}
function snapshot(v: unknown): LaneSnapshot | null {
  if (!record(v)) return null
  const c = cursor(v.cursor),
    s = summary(v.summary)
  if (!c || !s || (v.state !== null && !piState(v.state))) return null
  const messages = list(v.messages, HOST_LIMITS.outboundFrameBytes, (x) =>
    piMessage(x) ? x : null,
  )
  const pending = list(v.pending, HOST_LIMITS.pendingEvents, (x) => (piEvent(x) ? x : null))
  const dialogs = list(v.dialogs, HOST_LIMITS.outboundFrameBytes, (x) => (piDialog(x) ? x : null))
  const ui = list(v.ui, HOST_LIMITS.uiStatusKeys + HOST_LIMITS.uiWidgetKeys + 1, (x) =>
    piUi(x) ? x : null,
  )
  if (
    !ui ||
    ui.filter((request) => request.method === 'setStatus').length > HOST_LIMITS.uiStatusKeys ||
    ui.filter((request) => request.method === 'setWidget').length > HOST_LIMITS.uiWidgetKeys ||
    ui.filter((request) => request.method === 'setTitle').length > 1
  )
    return null
  return messages && pending && dialogs
    ? { cursor: c, summary: s, state: v.state, messages, pending, dialogs, ui }
    : null
}
function event(v: unknown): LaneEvent | null {
  if (!record(v)) return null
  if (v.kind === 'control') {
    const c = control(v.control)
    return c ? { kind: v.kind, control: c } : null
  }
  if (v.kind === 'summary') {
    const s = summary(v.summary)
    return s ? { kind: v.kind, summary: s } : null
  }
  if (v.kind === 'dialog-resolved' && frameId(v.dialogId))
    return { kind: v.kind, dialogId: v.dialogId }
  if (v.kind !== 'pi' || !record(v.push)) return null
  const p = v.push
  if (p.kind === 'event' && piEvent(p.event))
    return { kind: v.kind, push: { kind: p.kind, event: p.event } }
  if (p.kind === 'extension-ui' && piDialog(p.request))
    return { kind: v.kind, push: { kind: p.kind, request: p.request } }
  if (
    p.kind === 'exit' &&
    (p.code === null || integer(p.code)) &&
    (p.signal === null || text(p.signal, 64)) &&
    typeof p.expected === 'boolean'
  )
    return {
      kind: v.kind,
      push: { kind: p.kind, code: p.code, signal: p.signal, expected: p.expected },
    }
  return null
}
const rejects: readonly RejectCode[] = [
  'bad-request',
  'unsupported',
  'forbidden',
  'unknown-lane',
  'lane-stopped',
  'not-controller',
  'stale-fence',
  'conflict',
  'busy',
  'too-many-requests',
]
const errors: readonly CallErrorCode[] = [
  'bad-request',
  'unsupported',
  'forbidden',
  'unknown-lane',
  'lane-stopped',
  'too-large',
  'internal',
]
function receipt(v: unknown): Receipt | null {
  if (!record(v) || !isUuid(v.requestId)) return null
  const requestId = v.requestId
  switch (v.status) {
    case 'pending':
    case 'unknown':
      return { requestId, status: v.status }
    case 'done':
      if (
        (v.fence !== undefined && !integer(v.fence, 1)) ||
        (v.laneId !== undefined && !isUuid(v.laneId)) ||
        (v.data !== undefined && utf8Length(JSON.stringify(v.data)) > HOST_LIMITS.receiptDataBytes)
      )
        return null
      return {
        requestId,
        status: v.status,
        ...(v.data !== undefined ? { data: v.data } : {}),
        ...(v.fence !== undefined ? { fence: v.fence } : {}),
        ...(v.laneId !== undefined ? { laneId: v.laneId } : {}),
      }
    case 'failed':
      return record(v.error) &&
        member(v.error.code, ['pi-error', 'timeout', 'internal']) &&
        text(v.error.message, HOST_LIMITS.messageChars)
        ? { requestId, status: v.status, error: { code: v.error.code, message: v.error.message } }
        : null
    case 'rejected': {
      const c = v.control === undefined ? undefined : control(v.control)
      return member(v.code, rejects) && c !== null
        ? { requestId, status: v.status, code: v.code, ...(c ? { control: c } : {}) }
        : null
    }
    default:
      return null
  }
}
export function parseHostFrame(s: string): Parsed<HostFrame> {
  const p = readJson(s, HOST_LIMITS.outboundFrameBytes)
  if (!p.ok) return p
  const v = p.value
  const good = (value: HostFrame): Parsed<HostFrame> => ({ ok: true, value })
  const bad = (): Parsed<HostFrame> => ({ ok: false, reason: 'host-frame' })
  switch (v.type) {
    case 'ready': {
      if (
        !record(v.hello) ||
        !isUuid(v.hello.hostId) ||
        !hex(v.hello.runtimeEpoch) ||
        !capabilities(v.hello.capabilities)
      )
        return bad()
      const h = validateHostHello(v.hello, v.hello.hostId)
      if (
        !h.ok ||
        v.protocolVersion !== HOST_PROTOCOL_VERSION ||
        !text(v.proof, 86, 86) ||
        !/^[A-Za-z0-9_-]{85}[AQgw]$/.test(v.proof) ||
        !hex(v.connectionId) ||
        !isIsoTime(v.grantExpiresAt) ||
        !record(v.client) ||
        !isUuid(v.client.id) ||
        !label(v.client.label) ||
        !capabilities(v.capabilities) ||
        !v.capabilities.every((c) => h.hello.capabilities.includes(c))
      )
        return bad()
      return good({
        type: v.type,
        protocolVersion: HOST_PROTOCOL_VERSION,
        hello: h.hello,
        proof: v.proof,
        connectionId: v.connectionId,
        grantExpiresAt: v.grantExpiresAt,
        client: { id: v.client.id, label: v.client.label },
        capabilities: v.capabilities,
      })
    }
    case 'auth-renewed':
      return isIsoTime(v.grantExpiresAt)
        ? good({ type: v.type, grantExpiresAt: v.grantExpiresAt })
        : bad()
    case 'lanes': {
      const c = cursor(v.cursor),
        r = list(v.repositories, HOST_LIMITS.repositoriesPerHost, repository),
        l = list(v.lanes, HOST_LIMITS.lanesPerHost, summary)
      return frameId(v.id) && c && r && l
        ? good({ type: v.type, id: v.id, cursor: c, repositories: r, lanes: l })
        : bad()
    }
    case 'lanes-delta': {
      const c = cursor(v.cursor, 1),
        u = list(v.upsert, HOST_LIMITS.lanesPerHost, summary),
        r = list(v.remove, HOST_LIMITS.lanesPerHost, (x) => (isUuid(x) ? x : null))
      return frameId(v.id) && c && u && r
        ? good({ type: v.type, id: v.id, cursor: c, upsert: u, remove: r })
        : bad()
    }
    case 'attention': {
      const c = cursor(v.cursor, 1),
        e = v.event
      if (
        !frameId(v.id) ||
        !c ||
        !record(e) ||
        !isUuid(e.laneId) ||
        !integer(e.attention, 1) ||
        e.id !== `${e.laneId}:${e.attention}` ||
        !member(e.kind, [
          'finished',
          'needs-input',
          'failed',
          'routine-finished',
          'routine-paused',
        ]) ||
        !isIsoTime(e.at) ||
        (e.title !== null && !label(e.title))
      )
        return bad()
      return good({
        type: v.type,
        id: v.id,
        cursor: c,
        event: {
          id: e.id,
          laneId: e.laneId,
          kind: e.kind,
          attention: e.attention,
          at: e.at,
          title: e.title,
        },
      })
    }
    case 'snapshot': {
      const s = snapshot(v.snapshot)
      return frameId(v.id) &&
        isUuid(v.laneId) &&
        s &&
        s.summary.laneId === v.laneId &&
        typeof v.reset === 'boolean'
        ? good({ type: v.type, id: v.id, laneId: v.laneId, reset: v.reset, snapshot: s })
        : bad()
    }
    case 'event': {
      const c = cursor(v.cursor, 1),
        e = event(v.event)
      return frameId(v.id) &&
        isUuid(v.laneId) &&
        c &&
        e &&
        (e.kind !== 'summary' || e.summary.laneId === v.laneId)
        ? good({ type: v.type, id: v.id, laneId: v.laneId, cursor: c, event: e })
        : bad()
    }
    case 'subscribe-failed':
      return frameId(v.id) &&
        member(v.code, ['unknown-lane', 'too-many', 'forbidden', 'bad-request', 'too-large'])
        ? good({ type: v.type, id: v.id, code: v.code })
        : bad()
    case 'receipt': {
      const r = receipt(v.receipt)
      return r ? good({ type: v.type, receipt: r }) : bad()
    }
    case 'result':
      if (!frameId(v.id)) return bad()
      if (v.ok === true && 'data' in v)
        return good({ type: v.type, id: v.id, ok: true, data: v.data })
      return v.ok === false &&
        record(v.error) &&
        member(v.error.code, errors) &&
        text(v.error.message, HOST_LIMITS.messageChars)
        ? good({
            type: v.type,
            id: v.id,
            ok: false,
            error: { code: v.error.code, message: v.error.message },
          })
        : bad()
    case 'error':
      return typeof v.code === 'number' &&
        Object.values(HOST_CLOSE).some((x) => x === v.code) &&
        text(v.message, HOST_LIMITS.messageChars)
        ? good({ type: v.type, code: hostClose(v.code), message: v.message })
        : bad()
    case 'pong':
      return integer(v.at) ? good({ type: v.type, at: v.at }) : bad()
    default:
      return bad()
  }
}
function hostClose(code: number): HostCloseCode {
  for (const c of Object.values(HOST_CLOSE)) if (c === code) return c
  return HOST_CLOSE.badFrame
}
