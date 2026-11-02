import type { LaneReceipt } from '../lane-receipt'
import type { HostCapability } from '../remote-host'
import type {
  LaneCreatePhase,
  RepositorySummary,
  LaneSummary,
  StreamCursor,
} from '../host-protocol'
import type { ControlErrorCode } from '../control-api'
import type { LiveSessionInfo } from '../models'

export type DesktopControlErrorCode = ControlErrorCode | 'signed-out' | 'offline'

export type ControlResult<T> =
  ({ ok: true } & T) | { ok: false; error: { code: DesktopControlErrorCode; message: string } }

/** Parsed session tree (subset of entries) for the tree view. */
export interface SessionTreeEntry {
  id: string
  parentId: string | null
  type: string
  timestamp: string
  role?: string
  preview?: string
  toolName?: string
  targetId?: string
  label?: string
  summary?: string
  name?: string
  /** model_change entries. */
  provider?: string
  modelId?: string
  /** thinking_level_change entries. */
  thinkingLevel?: string
}

export interface SessionTree {
  sessionId: string
  cwd: string
  entries: SessionTreeEntry[]
  leafId: string | null
}

export type HostLaneView = Omit<LaneSummary, 'control' | 'pinned'> & {
  /** Pinned on the Host; `marker` is the Host's explicit marker choice. */
  pinned?: boolean
  control: {
    fence: number
    controller: { label: string; connected: boolean; self: boolean } | null
  }
}

export interface HostConnectionView {
  /** Opaque main-owned transport incarnation, independent of the Host runtime epoch. */
  connectionToken: string
  state:
    | 'down'
    | 'no-address'
    | 'connecting'
    | 'ready'
    | 'reconnecting'
    | 'wrong-machine'
    | 'unsupported'
    | 'signed-out'
  hostVersion?: string
  /** Host supports settings before this client requests configuration authority. */
  configurationSupported?: boolean
  /** Host opens shells in its account's home folder, outside any lane. */
  machineShell?: boolean
  /** Host keeps lane pins and markers, so every client shows the same ones. */
  laneMarks?: boolean
  /** Host takes a first prompt with `lane.create` and reports its phases. */
  laneStart?: boolean
  /** This client's `lane.create` commands still awaiting a receipt, oldest first. */
  laneStarts?: LaneStartView[]
  capabilities: HostCapability[]
  repositories: RepositorySummary[]
  lanes: HostLaneView[]
  cursor?: StreamCursor
  lastError?: string
}

export type HostsSnapshot = Record<string, HostConnectionView>

/**
 * One line of Desktop's remote traffic log (`hosts:traffic`): what crossed the
 * wire and when, never what it said. Kinds, method names, ids, sizes, timings
 * and error codes only; no payload, grant or terminal input is ever recorded.
 */
export interface TrafficEntry {
  /** Monotonic within this app run; the poll cursor. */
  seq: number
  /** Epoch milliseconds. */
  at: number
  peer: 'control' | 'host'
  hostId?: string
  /** `call` is one request and its reply; `state` is a lifecycle change, not a frame. */
  direction: 'out' | 'in' | 'call' | 'state'
  kind: string
  detail?: string
  bytes?: number
  ms?: number
  outcome?: 'ok' | 'error'
  code?: string
}

export interface TrafficPage {
  entries: TrafficEntry[]
  /** Newest seq recorded so far: pass it back as `after`. */
  last: number
  /** True when entries after `after` were dropped before this read. */
  gap: boolean
}

/**
 * One lane creation in flight. `phase` is absent until the Host reports one,
 * so a slow or older Host still shows the request as waiting. Never the prompt.
 */
export interface LaneStartView {
  repositoryId: string
  /** The requested branch; a fresh one may land with a `-2`…`-5` suffix. */
  branch: string | null
  phase?: LaneCreatePhase
}

/** A new lane on a Host (11). The Host picks the folder; never a path from here. */
export interface RemoteLaneCreate {
  repositoryId: string
  worktree?: { branch: string; fresh?: true }
  name?: string
  provider?: string
  model?: string
  thinkingLevel?: string
  /** Sent with the creation only to a `laneStart` Host; otherwise ignored. */
  prompt?: string
}

/** `prompted`: the Host already sent `RemoteLaneCreate.prompt` to the new lane. */
export type RemoteLaneStarted = LiveSessionInfo & { prompted?: boolean }

/** An attention event from any Host, for in-app and OS notifications (49). */
export interface HostAttention {
  receipt?: LaneReceipt
  hostId: string
  laneId: string
  kind: 'finished' | 'needs-input' | 'failed' | 'routine'
  title: string
  at: string
}
