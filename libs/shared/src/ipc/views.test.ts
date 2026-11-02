import { expectTypeOf, it } from 'vitest'
import type {
  DesktopControlErrorCode,
  ControlResult,
  SessionTreeEntry,
  SessionTree,
  HostLaneView,
  HostConnectionView,
  HostsSnapshot,
  TrafficEntry,
  TrafficPage,
  RemoteLaneCreate,
  HostAttention,
} from '../ipc'
import type { LaneReceipt } from '../lane-receipt'
import type { HostCapability } from '../remote-host'
import type {
  LaneCreatePhase,
  RepositorySummary,
  LaneSummary,
  StreamCursor,
} from '../host-protocol'
import type { ControlErrorCode } from '../control-api'

export type BaselineDesktopControlErrorCode = ControlErrorCode | 'signed-out' | 'offline'

export type BaselineControlResult<T> =
  | ({ ok: true } & T)
  | { ok: false; error: { code: BaselineDesktopControlErrorCode; message: string } }

/** Parsed session tree (subset of entries) for the tree view. */
export interface BaselineSessionTreeEntry {
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

export interface BaselineSessionTree {
  sessionId: string
  cwd: string
  entries: BaselineSessionTreeEntry[]
  leafId: string | null
}

export type BaselineHostLaneView = Omit<LaneSummary, 'control' | 'pinned'> & {
  pinned?: boolean
  control: {
    fence: number
    controller: { label: string; connected: boolean; self: boolean } | null
  }
}

export interface BaselineHostConnectionView {
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
  configurationSupported?: boolean
  machineShell?: boolean
  laneMarks?: boolean
  laneStart?: boolean
  laneStarts?: { repositoryId: string; branch: string | null; phase?: LaneCreatePhase }[]
  capabilities: HostCapability[]
  repositories: RepositorySummary[]
  lanes: BaselineHostLaneView[]
  cursor?: StreamCursor
  lastError?: string
}

export type BaselineHostsSnapshot = Record<string, BaselineHostConnectionView>

/**
 * One line of Desktop's remote traffic log (`hosts:traffic`): what crossed the
 * wire and when, never what it said. Kinds, method names, ids, sizes, timings
 * and error codes only; no payload, grant or terminal input is ever recorded.
 */
export interface BaselineTrafficEntry {
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

export interface BaselineTrafficPage {
  entries: BaselineTrafficEntry[]
  /** Newest seq recorded so far: pass it back as `after`. */
  last: number
  /** True when entries after `after` were dropped before this read. */
  gap: boolean
}

/** A new lane on a Host (11). The Host picks the folder; never a path from here. */
export interface BaselineRemoteLaneCreate {
  repositoryId: string
  worktree?: { branch: string; fresh?: true }
  name?: string
  provider?: string
  model?: string
  thinkingLevel?: string
  prompt?: string
}

/** An attention event from any Host, for in-app and OS notifications (49). */
export interface BaselineHostAttention {
  receipt?: LaneReceipt
  hostId: string
  laneId: string
  kind: 'finished' | 'needs-input' | 'failed' | 'routine'
  title: string
  at: string
}
it('freezes public view fields, redaction and optionality', () => {
  expectTypeOf<DesktopControlErrorCode>().toEqualTypeOf<BaselineDesktopControlErrorCode>()
  expectTypeOf<ControlResult<{ value: string }>>().toEqualTypeOf<
    BaselineControlResult<{ value: string }>
  >()
  expectTypeOf<SessionTreeEntry>().toEqualTypeOf<BaselineSessionTreeEntry>()
  expectTypeOf<SessionTree>().toEqualTypeOf<BaselineSessionTree>()
  expectTypeOf<HostLaneView>().toEqualTypeOf<BaselineHostLaneView>()
  expectTypeOf<HostConnectionView>().toEqualTypeOf<BaselineHostConnectionView>()
  expectTypeOf<HostsSnapshot>().toEqualTypeOf<BaselineHostsSnapshot>()
  expectTypeOf<TrafficEntry>().toEqualTypeOf<BaselineTrafficEntry>()
  expectTypeOf<TrafficPage>().toEqualTypeOf<BaselineTrafficPage>()
  expectTypeOf<RemoteLaneCreate>().toEqualTypeOf<BaselineRemoteLaneCreate>()
  expectTypeOf<HostAttention>().toEqualTypeOf<BaselineHostAttention>()
})

import type * as Views from './views'
it('exposes the same bounded views from the leaf', () => {
  expectTypeOf<Views.HostConnectionView>().toEqualTypeOf<BaselineHostConnectionView>()
  expectTypeOf<Views.HostLaneView>().toEqualTypeOf<BaselineHostLaneView>()
  expectTypeOf<Views.TrafficPage>().toEqualTypeOf<BaselineTrafficPage>()
  expectTypeOf<Views.SessionTree>().toEqualTypeOf<BaselineSessionTree>()
  expectTypeOf<Views.RemoteLaneCreate>().toEqualTypeOf<BaselineRemoteLaneCreate>()
  expectTypeOf<Views.HostAttention>().toEqualTypeOf<BaselineHostAttention>()
})
it('redacts controller identity and keeps remote state fields optional', () => {
  type Controller = NonNullable<Views.HostLaneView['control']['controller']>
  expectTypeOf<keyof Controller>().toEqualTypeOf<'label' | 'connected' | 'self'>()
  expectTypeOf<'clientId'>().not.toExtend<keyof Controller>()
  expectTypeOf<Views.HostConnectionView['cursor']>().toEqualTypeOf<StreamCursor | undefined>()
  expectTypeOf<Views.HostConnectionView['hostVersion']>().toEqualTypeOf<string | undefined>()
  expectTypeOf<Views.HostAttention['receipt']>().toEqualTypeOf<LaneReceipt | undefined>()
  expectTypeOf<Views.RemoteLaneCreate['worktree']>().toEqualTypeOf<
    { branch: string; fresh?: true } | undefined
  >()
})
