/**
 * Agent control's owner-side contracts: who asks (`OpPrincipal`), what a
 * handler receives and returns, the per-owner binding the dispatcher runs over,
 * and the dispatcher itself. Desktop's in-app binding and the daemon's binding
 * both implement `OpsBinding`; nothing here does IO. Living contract:
 * docs/agent-control.md.
 */
import type { OpsRunRequest, OpsRunResult } from '@phosphor/shared/host-protocol-ops'
import type { LaneActivity, ReadyOpFlag } from '@phosphor/shared/host-protocol'
import type {
  AgentOpRow,
  AgentPolicy,
  LaneEffect,
  OpFacts,
  OpReplyEnvelope,
  OpRequestEnvelope,
} from '@phosphor/shared/ops'
import type { ExtensionUIResponse } from '@phosphor/shared/rpc'
import type { OpsChangedEvent } from '@phosphor/shared/ipc'
import type { ReachBudget, ReachMachine } from './reach'
import type { AuditLog } from './audit'
import type { RuntimeLog } from '../file-log'

/**
 * Who asks for an op. A `surface` is a signed-in user's click (over a user
 * grant, or Desktop over the owner socket); an `agent` is a lane on this
 * machine; a `machine` is another enrolled machine's agent; a `local` is a
 * same-user process on this machine's socket (the CLI), optionally naming the
 * lane it runs in. `lane` on `local` and `actor` on a request are attribution
 * and a downgrade only, never authority.
 */
export type OpPrincipal =
  | {
      readonly kind: 'surface'
      readonly clientId: string
      readonly label: string
      readonly via: 'grant' | 'owner'
    }
  | {
      readonly kind: 'agent'
      readonly laneRef: string
      readonly sessionId: string
      /** A routine run with no one watching: asked ops answer `unattended`. */
      readonly unattended: boolean
      /** Depth of agent-created lanes above this one; 0 for a lane a user started. */
      readonly lineage: number
    }
  | {
      readonly kind: 'machine'
      readonly machineId: string
      readonly clientId: string
      readonly label: string
      /** The asking lane on the calling machine, when it said. */
      readonly lane: string | null
    }
  | { readonly kind: 'local'; readonly clientId: string; readonly lane?: string }

/** Who sent a lane command on a Host connection; absent means `surface`. */
export type LaneCommandOrigin = 'surface' | 'machine' | 'local'

/** What the owner knows about one lane when an op names it. */
export interface LaneFacts {
  /** The lane as this machine names it: `host:<hostId>/lane:<laneId>` or `local/session:<id>`. */
  readonly ref: string
  /** The pi session id, when the lane has a session yet. */
  readonly sessionId: string | null
  readonly title: string
  /** The lane's working folder; Brain and directives resolve against it. */
  readonly cwd: string
  /** Host activity, when the owner supplies its lane projection. */
  readonly activity?: LaneActivity
  /** A turn is running. */
  readonly busy: boolean
  readonly controlFence?: number
  /** The connected client in control, if any; surface ops on another lane check it. */
  readonly controller: { readonly clientId: string; readonly label: string } | null
  /** What the lane's own tool reported with this request; absent for any other lane. */
  readonly facts?: OpFacts
}

/** Work the owner applies to a lane after the op answers (next request, after the run, reload). */
export type LaneDeferred = (
  | { readonly kind: 'account'; readonly accountId: string }
  | { readonly kind: 'model'; readonly provider: string; readonly modelId: string }
  | { readonly kind: 'thinking'; readonly level: string }
  | { readonly kind: 'autoCompaction' | 'autoRetry'; readonly enabled: boolean }
  | { readonly kind: 'steering' | 'follow-up'; readonly mode: 'all' | 'one-at-a-time' }
  | { readonly kind: 'reload'; readonly what: string }
  | { readonly kind: 'stop' }
  | { readonly kind: 'archive' }
  | { readonly kind: 'compact'; readonly instructions?: string }
) & { readonly action?: () => Promise<OpHandlerResult> }

export type DeferredOutcome =
  { readonly ok: true } | { readonly ok: false; readonly message: string }

export interface OpHandlerContext {
  readonly principal: OpPrincipal
  readonly reason?: string
  readonly signal: AbortSignal
  /** The lane the op is about, when it names one (or is the asking lane's own op). */
  readonly lane?: LaneFacts
  /** The asking lane's deferred changes; absent when this owner cannot observe them. */
  readonly pending?: readonly LaneDeferred[]
  readonly log: RuntimeLog
}

export interface OpHandlerResult {
  readonly text: string
  /** Status without transcript text, when the result displays untrusted content. */
  readonly auditText?: string
  readonly data?: unknown
  /** The state an inverse must still match for Undo. */
  readonly undo?: false
  readonly fingerprint?: string
  readonly before?: unknown
  readonly effects?: readonly LaneEffect[]
  readonly deferred?: readonly LaneDeferred[]
  /** A suggested next op for the agent. */
  readonly next?: string
}

/** One catalog op's implementation on one owner. Args arrive validated against the op's schema. */
export type OpHandler = (args: unknown, ctx: OpHandlerContext) => Promise<OpHandlerResult>

/** The agent policy this owner enforces. */
export interface PolicyStore {
  /** `changedOutside`: the stored policy differs from the owner's last write (daemon only). */
  read(): Promise<{ readonly policy: AgentPolicy; readonly changedOutside: boolean }>
  write(policy: AgentPolicy): Promise<void>
}

/** The owner's audit log; rows are redacted before they get here. */
export interface AuditStore {
  /** Returns the row's id. */
  append(row: Omit<AgentOpRow, 'id'>): Promise<string>
  list(query: {
    readonly laneRef?: string
    readonly beforeId?: string
    readonly before?: number
    readonly limit: number
  }): Promise<readonly AgentOpRow[]>
}

/** Brain's agent reads, served by the Desktop app service. Inputs carry the owner-filled lane context. */
export interface BrainOpsPort {
  search(input: Readonly<Record<string, unknown>>): Promise<unknown>
  flag(input: Readonly<Record<string, unknown>>): Promise<unknown>
}

/** One caller budget shared by directory resolution and every queued host. */
export interface OpDeadline extends ReachBudget {
  readonly deadlineAt: number
  readonly signal: AbortSignal
  readonly now: () => number
}

/** Everything one owner (Desktop in-app, or the daemon) gives the dispatcher. */
export interface OpsBinding {
  /** The enrolled Host id, or null before enrollment and on Desktop in-app. */
  readonly machineId: string | null
  readonly handlers: Readonly<Record<string, OpHandler>>
  /** Ops this owner answers `unsupported`, with the sentence it says. */
  readonly gaps: Readonly<Partial<Record<string, string>>>
  /** The `ready` flags this owner serves; an op whose flag is absent is a gap. */
  readonly flags: ReadonlySet<ReadyOpFlag>
  readonly policy: PolicyStore
  readonly audit: AuditLog
  readonly lanes: {
    resolve(ref: string): LaneFacts | null
    lookup?(ref: string): Promise<LaneFacts | null>
    createdBy(laneRef: string): { readonly lineage: number; readonly creator?: string } | null
  }
  readonly deferred: {
    apply(sessionOrLaneId: string, items: readonly LaneDeferred[]): Promise<DeferredOutcome>
  }
  /** `--host`: the same request on another machine. */
  readonly remote?: {
    run(
      hostId: string,
      request: OpsRunRequest,
      options: OpDeadline & { readonly target?: ReachMachine },
    ): Promise<OpsRunResult>
  }
  readonly brain?: BrainOpsPort
  notifySurfaces(event: Omit<OpsChangedEvent, 'machine'>): void
}

/** The owner's one entry point for ops from a lane's tool and from every other principal. */
export interface OpsDispatcher {
  runFromCli(
    principal: Extract<OpPrincipal, { kind: 'local' }>,
    envelope: OpRequestEnvelope,
  ): Promise<OpsRunResult>
  runFromTool(sessionId: string, envelope: OpRequestEnvelope): Promise<OpReplyEnvelope>
  run(principal: OpPrincipal, request: OpsRunRequest): Promise<OpsRunResult>
  /** A surface answered a lane's dialog: relay it, or refuse a forged answer to an op confirm. */
  surfaceAnswered(
    sessionId: string,
    response: ExtensionUIResponse,
    origin?: string,
  ): 'relay' | 'forbidden'
  confirmSeen(sessionId: string, dialog: { id: string; title: string; message: string }): void
  settled(sessionId: string, run: { terminatedBy?: 'phosphor' }): Promise<void>
  userPrompted(sessionId: string): void
  cancelLane(sessionId: string): void
  undo(principal: OpPrincipal, auditId: string): Promise<OpsRunResult>
}
