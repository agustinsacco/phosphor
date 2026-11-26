/**
 * The ports `createOpsDispatcher` needs beyond the owner's `OpsBinding`: the
 * command-line parser, the pending-confirmation store, audit redaction, undo,
 * background jobs and `--host` resolution. Each is a narrow interface so an
 * owner binds the real module (parser, confirm store, jobs table) behind it.
 * Living contract: docs/agent-control.md.
 */
import type {
  OpsBatchRef,
  OpsConfirmRef,
  OpsJobData,
  OpsRunRequest,
  OpsRunResult,
} from '@phosphor/shared/host-protocol-ops'
import type { CatalogSpec } from '@phosphor/shared/ops-catalog'
import type { ConfirmInfo, OpArgs } from '@phosphor/shared/ops'
import type { ExtensionUIResponse } from '@phosphor/shared/rpc'
import type { RuntimeLog } from '../file-log'
import type { ConfirmTarget } from './confirm-message'
import type { AgentPrincipal } from './principals'
import type { LaneFacts, OpHandlerContext, OpHandlerResult, OpPrincipal } from './types'

/** The argv parser's answer (the `phosphor` tool's command line). */
export type ParsedOpArgv =
  | {
      readonly ok: true
      readonly op: string
      readonly args: OpArgs
      /** `--host a,b` or `--host all`. */
      readonly hosts?: readonly string[] | 'all'
      readonly page?: string
      readonly limit?: number
      readonly reason?: string
    }
  | { readonly ok: false; readonly error: string }

export type OpsConfirmResult = Extract<OpsRunResult, { status: 'confirm' }>

/** What an asked op leaves pending until the user answers. */
export interface PendingConfirm {
  /** Authenticated asker; only it may read the status or redeem it. */
  readonly principal: OpPrincipal
  /** The asking lane's pi session, whose dialog the confirmation binds to; null for CLI and machine asks. */
  readonly sessionId: string | null
  readonly origin: ConfirmInfo['origin']
  readonly spec: CatalogSpec
  readonly args: OpArgs
  readonly reason?: string
  /** A `--host` ask names each machine (`machineLabel`) and carries its own confirm. */
  readonly items: readonly ConfirmTarget[]
  /** The target lane; the message names its controlling client when another one controls it. */
  readonly lane?: LaneFacts
  readonly batch?: OpsBatchRef
}

/** A resubmission that carries a confirmation reference. */
export interface ConfirmAttempt {
  readonly principal: OpPrincipal
  readonly sessionId: string | null
  readonly confirm: OpsConfirmRef
  readonly op: string
  readonly args: OpArgs
}

/**
 * `approved` is returned at most once per confirmation (atomic, single use);
 * `pending` leaves it redeemable after the user answers.
 */
export type ConfirmRedemption = 'approved' | 'pending' | 'denied' | 'expired' | 'mismatch'

/** The pending-confirmation store (bind, digest, single use, expiry, creator-only status). */
export interface OpsConfirmPort {
  create(
    pending: PendingConfirm,
  ): Promise<OpsConfirmResult | Extract<OpsRunResult, { status: 'denied' }>>
  consume(attempt: ConfirmAttempt): Promise<ConfirmRedemption>
  /** Null unless this principal created it. */
  status(confirmId: string, principal: OpPrincipal): Promise<ConfirmInfo | null>
  surfaceAnswered(
    sessionId: string,
    response: ExtensionUIResponse,
    origin?: string,
  ): 'relay' | 'forbidden'
  confirmSeen(sessionId: string, dialog: { id: string; title: string; message: string }): void
  /** Stop or exit: the session's pending confirmations can no longer be redeemed. */
  voidSession(sessionId: string): void
}

/** The redo record and the surface-only Undo. */
export interface OpsUndoPort {
  run(
    principal: OpPrincipal,
    auditId: string,
    run: (principal: OpPrincipal, request: OpsRunRequest) => Promise<OpsRunResult>,
  ): Promise<OpsRunResult>
}

/** Ops that can outlast an answer deadline run here and report through `job.status`. */
export interface OpsJobPort {
  start(job: {
    readonly creator: string
    readonly op: string
    readonly run: (signal: AbortSignal) => Promise<OpHandlerResult>
    readonly completed?: (result: OpHandlerResult) => void
  }): Promise<OpsJobData>
}

export interface RoutedHost {
  /** The enrolled Host id `binding.remote.run` takes. */
  readonly id: string
  readonly label: string
}

/**
 * `--host` resolution (labels, id prefixes, `all` in directory order, which is
 * every other machine). `self` means the one value named this machine, which
 * then runs the op here.
 */
export interface OpsHostResolver {
  resolve(
    hosts: readonly string[] | 'all',
  ): Promise<
    | { readonly ok: true; readonly hosts: readonly RoutedHost[] }
    | { readonly ok: true; readonly self: true }
    | { readonly ok: false; readonly text: string }
  >
}

export type SurfacePrincipal = Extract<OpPrincipal, { kind: 'surface' }>

export interface OpsDispatcherDeps {
  parseArgv(argv: readonly string[], content?: string): ParsedOpArgv
  /** The agent principal for a live pi session, or null when the owner does not know it. */
  agentFor(sessionId: string): AgentPrincipal | null
  /** Whether a surface's connection holds what the op `requires` (caps, configure authority). */
  surfaceAdmits(
    principal: SurfacePrincipal,
    requires: NonNullable<CatalogSpec['requires']>,
  ): boolean
  confirms: OpsConfirmPort
  /** The audit row's `argsSummary`: sensitive args redacted, at most 2 KiB. */
  redact(spec: CatalogSpec, args: OpArgs): string
  undo: OpsUndoPort
  /** Absent: `job` ops run inline. */
  jobs?: OpsJobPort
  /** Additional long-running ops on this owner only. */
  background?(request: OpsRunRequest, self: boolean): boolean
  /** Resolve a destructive wildcard to the exact ids being authorized. */
  archiveIds?(): Promise<string[]>
  /** Absent: `--host` takes Host ids as given and refuses `all`. */
  hosts?: OpsHostResolver
  log: RuntimeLog
  now?: () => number
  /** Defaults to `OP_CATALOG`. */
  catalog?: readonly CatalogSpec[]
}

/** What a handler sees beyond `OpHandlerContext`: the caller's page token. */
export interface OpRunContext extends OpHandlerContext {
  readonly page?: string
  readonly limit?: number
}

/** The page token a paged handler continues from. */
export function requestPage(ctx: OpHandlerContext): string | undefined {
  return (ctx as OpRunContext).page
}

/** The explicit page size, if the op does not declare its own limit argument. */
export function requestLimit(ctx: OpHandlerContext): number | undefined {
  return (ctx as OpRunContext).limit
}
