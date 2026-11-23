import type { OpsRunRequest, OpsRunResult } from '../host-protocol-ops'
import type { HostTarget } from '../remote-host'

export interface OpsInvokeMap {
  /**
   * One agent-control catalog op as a surface (a user's click), never as an
   * agent. `local`: Desktop's in-app binding before migration, the local
   * daemon after. `remote`: that Host. Audit, policy, confirmations and undo
   * are catalog ops too (`audit.list`, `policy.show|set`,
   * `confirm.info|list|approve|deny|status`, `audit.undo`); there is no other
   * ops channel. An older Host answers `{status: 'denied', code: 'unsupported'}`.
   */
  'ops:run': { args: [target: HostTarget, request: OpsRunRequest]; result: OpsRunResult }
}

/**
 * Something agent control changed on one machine, pushed as `ops:changed`. A
 * change signal: listeners reload what they show through `ops:run`.
 */
export interface OpsChangedEvent {
  /** `local`, or `host:<hostId>`, as the routines channel names a machine. */
  machine: string
  kind: 'audit' | 'policy' | 'confirm' | 'lane'
  /** The lane the change belongs to, as its machine names it. */
  laneRef?: string
  /** For `lane`: which lane fields changed (`model`, `thinking`, …). */
  fields?: string[]
}
