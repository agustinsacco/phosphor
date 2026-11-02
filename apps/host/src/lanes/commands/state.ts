import type { DeleteLaneOp, RepositoryOp } from '@phosphor/shared/host-protocol-repositories'
import type { FileWriteOp } from '@phosphor/shared/host-protocol-writes'
import type {
  ClientFrame,
  LaneEvent,
  LaneSummary,
  Receipt,
  RejectCode,
} from '@phosphor/shared/host-protocol'
import type { RoutineOp } from '@phosphor/shared/host-protocol-routines'
import type { HostCapability } from '@phosphor/shared/remote-host'
import type { RpcCommand } from '@phosphor/shared/rpc'
import type { RuntimeLog } from '@phosphor/session-runtime/file-log'
import type { HostAttachments } from '../../features/attachments'
import type { WriteOutcome } from '../../features/writes'
import type { ProviderLogins } from '../../providers/login'
import type { MachineTasks } from '../../settings/tasks'
import type { HostRuntime } from '../../session/runtime'
import type { HostTerminals } from '../../terminals/service'
import type { LaneSessions } from '../create'
import { createRepositoryLocks, type RepositoryLocks } from '../repository-lock'
import type { HostStore, StoredLane } from '../store'

export const LANE_QUEUE_LIMIT = 32
export const COMMAND_CLOSE_GRACE_MS = 2000
export type LaneCommandFrame = Extract<ClientFrame, { type: 'command' }>
export interface LaneCommandClient {
  id: string
  label: string
  currentCaps?: () => readonly HostCapability[]
  connectionId?: string
  caps: readonly HostCapability[]
}
export interface LaneCommandPorts {
  moveClaudeAccount?: (
    laneId: string,
    accountId: string,
    authorized: () => boolean,
  ) => Promise<void>
  machineTasks?: Pick<MachineTasks, 'execute'>
  repositories?: {
    execute(
      op: RepositoryOp,
      allowed: () => boolean,
    ): Promise<{ ok: true; data?: unknown } | { ok: false; code: RejectCode }>
  }
  deleteLane?: (
    op: DeleteLaneOp,
    allowed: () => boolean,
  ) => Promise<{ ok: true; data: { branchKept: boolean } } | { ok: false; code: RejectCode }>
  providerLogins?: Pick<ProviderLogins, 'execute'>
  attachments?: HostAttachments
  terminals?: HostTerminals
  store: HostStore
  writes?: {
    capabilityFor(type: string): HostCapability | null
    execute(laneId: string, op: FileWriteOp): Promise<WriteOutcome>
  }
  sessions: LaneSessions
  runtime: Pick<HostRuntime, 'command' | 'extensionUiResponse'>
  /** Wiring owns projection delivery and the live-session mapping. */
  resumeLane(lane: StoredLane): Promise<void>
  stopLane(laneId: string): Promise<void>
  sessionFor(laneId: string): string | null
  openDialogs(laneId: string): readonly string[]
  /** Read after the store write: persisted control, counters and timestamps from
   * the store; live activity, title and model from the projection. */
  summaryFor(laneId: string): LaneSummary | null
  publish(laneId: string, event: LaneEvent): void
  /** The adapter fans out to interested connections of this client only. */
  deliver(clientId: string, receipt: Receipt, connectionId?: string): void
  now(): number
  log: RuntimeLog
  routines?: {
    execute(op: RoutineOp, requestId: string, caps: readonly HostCapability[]): Promise<unknown>
  }
  refusal?: (command: RpcCommand) => string | null
}

export type Terminal = Exclude<Receipt, { status: 'pending' }>
export type Job = {
  client: LaneCommandClient
  frame: LaneCommandFrame
  started: number
  resolve(): void
}
/** One lane's FIFO, or the machine queue under the empty key. */
export type LaneQueue = {
  jobs: Job[]
  /** Dispatched runtime promises not yet settled, including ones past their deadline. */
  outstanding: number
  /** Creations that stored this lane and have not finished attaching and publishing it. */
  holds: number
  draining: boolean
  controlUnpublished: boolean
}
export type Answer<T> = { answered: true; value: T } | { answered: false; reason: string }
/** A detached execution releases the queue at dispatch; its job resolves on completion. */
export type Execution = { completion: Promise<void>; detached: boolean }
export type OperationIdentity = { laneId: string; requestId: string; opType: string }
export type ExecuteJob = (job: Job, queue: LaneQueue) => Execution | void
/** What the queue needs from the router: the capability rule and the executor. */
export interface CommandRouter {
  capabilityFor(op: LaneCommandFrame['op']): readonly HostCapability[]
  execute: ExecuteJob
}

/** Every mutable value a command service owns. close() moves it closing, then closed. */
export interface CommandState {
  readonly queues: Map<string, LaneQueue>
  /** Runtime promises and completions that close() waits for, up to its grace. */
  readonly work: Set<Promise<unknown>>
  readonly limit: number
  /** Lane creations take turns per repository only for their worktree work. */
  readonly folders: RepositoryLocks
  /** Creations whose work has not settled, to the repository they create in. */
  readonly creations: Map<{ stored?: boolean }, string>
  closing: boolean
  closed: boolean
  closePromise: Promise<void> | undefined
}

export function createCommandState(limit: number = LANE_QUEUE_LIMIT): CommandState {
  if (!Number.isInteger(limit) || limit < 1 || limit > LANE_QUEUE_LIMIT)
    throw new Error('invalid lane queue limit')
  return {
    queues: new Map(),
    work: new Set(),
    limit,
    folders: createRepositoryLocks(),
    creations: new Map(),
    closing: false,
    closed: false,
    closePromise: undefined,
  }
}

export function track(state: CommandState, promise: Promise<unknown>): void {
  state.work.add(promise)
  void promise.finally(() => state.work.delete(promise)).catch(() => {})
}
