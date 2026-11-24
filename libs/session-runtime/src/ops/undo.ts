/**
 * Undo for audited agent changes. At write time `undoRecordFor` decides
 * whether a change can be undone at all: the op needs a catalog inverse, and
 * the inverse must hold nothing redaction would remove (an inverse that needs a
 * secret is never stored, so the row answers `undo: false`). At undo time
 * `createUndo` checks the preconditions and runs the inverse as the user.
 * Living contract: docs/agent-control.md.
 */
import type { OpsDenyCode, OpsRunRequest, OpsRunResult } from '@phosphor/shared/host-protocol-ops'
import type { OpArgs, OpSpec } from '@phosphor/shared/ops'
import type { AuditEntry, AuditLog, UndoRecord } from './audit'
import { redactsNothing } from './redact'
import type { OpPrincipal } from './types'

type Spec = Pick<OpSpec, 'name' | 'sensitive' | 'inverse'>

/**
 * The undo record to audit with a change, or null when it has no Undo.
 * `before` is the state the handler captured before it changed anything.
 */
export function undoRecordFor(
  spec: Spec,
  args: OpArgs,
  before: unknown,
  specFor: (op: string) => Pick<OpSpec, 'name' | 'sensitive'> | undefined,
): UndoRecord | null {
  if (!spec.inverse) return null
  let inverse: { op: string; args: OpArgs } | null
  try {
    inverse = spec.inverse(args, before)
  } catch {
    return null
  }
  const inverseSpec = inverse ? specFor(inverse.op) : undefined
  if (!inverse || !inverseSpec || !redactsNothing(inverseSpec, inverse.args)) return null
  return {
    inverse: { op: inverse.op, args: inverse.args },
    ...(redactsNothing(spec, args) ? { forward: args } : {}),
  }
}

export interface UndoPorts {
  readonly audit: Pick<AuditLog, 'get' | 'markUndone'>
  /**
   * True while the state the change set is still in place. The owner reads
   * its own state (it alone knows how); an error counts as false.
   */
  isCurrent(entry: AuditEntry & { readonly undoRecord: UndoRecord }): Promise<boolean>
  /** Run the inverse through the dispatcher as `principal`; the result carries its audit id. */
  run(principal: OpPrincipal, request: OpsRunRequest): Promise<OpsRunResult>
}

const denied = (code: OpsDenyCode, text: string): OpsRunResult => ({
  status: 'denied',
  code,
  text,
})

const UNDONE_DECISIONS: ReadonlySet<string> = new Set(['allowed', 'approved'])

/** `audit.undo` for one owner. Undos of the same row never overlap. */
export function createUndo(
  ports: UndoPorts,
): (principal: OpPrincipal, auditId: string) => Promise<OpsRunResult> {
  const running = new Set<string>()
  return async (principal, auditId) => {
    if (principal.kind !== 'surface') return denied('forbidden', 'Only you can undo, in Phosphor.')
    const entry = ports.audit.get(auditId)
    if (!entry) return denied('bad-request', 'There is no audited change with that id.')
    if (entry.undoneBy !== undefined)
      return denied('unavailable', 'This change was already undone.')
    if (!UNDONE_DECISIONS.has(entry.decision))
      return denied('unavailable', 'Nothing changed, so there is nothing to undo.')
    const record = entry.undoRecord
    if (!record) return denied('unavailable', 'This change has no Undo.')
    if (running.has(auditId)) return denied('busy', 'Undo of this change is already running.')
    running.add(auditId)
    try {
      const current = await ports.isCurrent({ ...entry, undoRecord: record }).catch(() => false)
      if (!current)
        return denied(
          'unavailable',
          'This changed again since, so Undo would overwrite the newer change.',
        )
      const result = await ports.run(principal, {
        op: record.inverse.op,
        args: record.inverse.args,
        reason: `Undo of ${entry.op} (${auditId})`,
      })
      if (result.status === 'ok') ports.audit.markUndone(auditId, result.auditId ?? 'unrecorded')
      return result
    } finally {
      running.delete(auditId)
    }
  }
}
