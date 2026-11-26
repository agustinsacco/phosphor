/**
 * Machine reach, caller side: the port the dispatcher uses to run an op on
 * another of the owner's machines (`--host`). The daemon binds it over machine
 * grants; nothing here does IO. Living contract: docs/agent-control.md
 * ("Machines").
 */
import type { OpsRunRequest } from '@phosphor/shared/host-protocol-ops'

export type ReachControlStage =
  'control-unreachable' | 'control-timeout' | 'rate-limited' | 'bad-response'

export interface ReachBudget {
  readonly signal?: AbortSignal
  readonly deadlineAt?: number
  readonly onRemoteWrite?: () => void
}

/** Why no machine list is available at all. */
export type ReachUnavailable =
  'signed-out' | 'control-old' | 'reach-off' | 'account-disabled' | ReachControlStage

export interface ReachMachine {
  readonly id: string
  readonly label: string
  readonly online: boolean
  readonly hostVersion: string | null
  readonly catalogOps?: boolean | 'unknown'
  /** Online and eligible for reach in the directory, before contacting the Host. */
  readonly ready: boolean
  readonly why?: 'offline' | 'not-enrolled' | 'reach-off' | 'stale-heartbeat'
}

export type ReachDirectory =
  | {
      readonly available: true
      readonly self: { readonly id: string; readonly label: string }
      readonly machines: readonly ReachMachine[]
    }
  | { readonly available: false; readonly reason: ReachUnavailable }

export type ReachResult =
  | { readonly ok: true; readonly data: unknown }
  | {
      readonly ok: false
      readonly code:
        | 'unsupported'
        | 'forbidden'
        | 'offline'
        | 'timeout'
        | 'unconfirmed'
        | 'too-large'
        | 'bad-request'
        | 'needs-confirm'
        | 'denied'
      readonly message: string
      readonly data?: unknown
    }

export interface Reach {
  directory(options?: ReachBudget & { readonly fresh?: boolean }): Promise<ReachDirectory>
  /** A write is never resent after a reconnect; an unknown receipt answers `unconfirmed`. */
  run(
    hostId: string,
    request: OpsRunRequest,
    options: ReachBudget & { readonly write: boolean; readonly target?: ReachMachine },
  ): Promise<ReachResult>
  close(): Promise<void>
}
