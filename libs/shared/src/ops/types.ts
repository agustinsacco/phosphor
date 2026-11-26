/**
 * Catalog types: what one agent-control op declares. The catalog table itself
 * is a separate module; this file only fixes the shape every entry has.
 * Reached through `../ops`.
 */
import type { OpApplies } from '../host-protocol-ops'
import type { ReadyOpFlag } from '../host-protocol/host-ready'
import type { LegacyHostCapability } from '../remote-host'

/** How much an op can change. `never` ops are listed for help and always refused to agents. */
export const OP_TIERS = [
  'read',
  'lane',
  'create',
  'configure',
  'persistence',
  'destructive',
  'never',
] as const
export type OpTier = (typeof OP_TIERS)[number]

/** Whose state an op touches. Any op routed to another machine is `machine`. */
export const OP_SCOPES = ['self', 'other-lane', 'machine'] as const
export type OpScope = (typeof OP_SCOPES)[number]

/** `service` ops (Brain) ignore the agent kill switch and run on their own queue. */
export const OP_CLASSES = ['control', 'service'] as const
export type OpClass = (typeof OP_CLASSES)[number]

/** What a tier or scope function may consult besides the args. */
export interface OpContext {
  /** The op targets the asking lane itself. */
  readonly self: boolean
}

export type OpArgs = Readonly<Record<string, unknown>>

/**
 * One catalog entry. `S` is the args schema (a closed object schema the
 * catalog module owns); `A` is the args it validates to.
 */
export interface OpSpec<A extends OpArgs = OpArgs, S = unknown> {
  /** `OP_NAME_PATTERN`, at most 64 characters. */
  readonly name: string
  /** One line; feeds help. */
  readonly summary: string
  readonly args: S
  /** Argument order for the command-line parser. */
  readonly positional?: readonly (keyof A & string)[]
  /** Which argument identifies the lane (instead of the legacy ref/lane fallback). */
  readonly laneArg?: 'target' | 'ref' | 'lane'
  readonly tier: OpTier | ((a: A, c: OpContext) => OpTier)
  readonly scope: OpScope | ((a: A, c: OpContext) => OpScope)
  readonly applies: OpApplies
  readonly class?: OpClass
  /** Redacted in audit rows, toasts and confirmations. */
  readonly sensitive?: readonly (keyof A & string)[]
  /** Surface principals only: `confirm.info|list|approve|deny`, `policy.set`, `audit.undo`. */
  readonly surfaceOnly?: true
  /** The `ready` boolean whose UI this op belongs to. */
  readonly flag?: ReadyOpFlag
  /** Checked for surface principals; policy governs agent, machine and local ones. */
  readonly requires?: {
    readonly caps?: readonly LegacyHostCapability[]
    readonly configure?: true
  }
  readonly inverse?: (a: A, before: unknown) => { op: string; args: OpArgs } | null
  /** The result carries other lanes', Brain or PR text: framed as data, never instructions. */
  readonly untrustedResult?: true
  /** False: never accepted with `--host`. */
  readonly routable?: false
  /** Pages with --page and --limit; the result carries a top-level next. */
  readonly paged?: true
  /** May outlast the Host's answer deadline: answers `OpsJobData` and reports through `job.status`. */
  readonly job?: true
}
