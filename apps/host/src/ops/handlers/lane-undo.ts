import { createHash } from 'node:crypto'
import type { AuditEntry } from '@phosphor/session-runtime/ops/audit'
import type { DaemonHandlerDeps } from './index'
import { laneIdOf } from '../binding'

/** A different session, mark, control fence or archive tombstone invalidates the inverse. */
function fingerprint(deps: DaemonHandlerDeps, id: string) {
  const row = deps.store.getLane(id)
  if (!row) return undefined
  const state = [
    row,
    deps.daemonLanes.sessionFor(id),
    deps.daemonLanes.summary(id),
    deps.store.archives.has(id),
  ]
  return createHash('sha256').update(JSON.stringify(state)).digest('hex')
}
export function laneChange(
  deps: DaemonHandlerDeps,
  id: string,
  text: string,
  before: Record<string, string>,
) {
  return { text, data: { laneId: id }, before, fingerprint: fingerprint(deps, id) }
}
export function laneUndoCurrent(deps: DaemonHandlerDeps, entry: AuditEntry) {
  const record = entry.undoRecord
  if (!record?.fingerprint) return false
  const ref = record.inverse.args.ref ?? record.inverse.args.id
  const id = typeof ref === 'string' && laneIdOf(ref, deps.selfIds())
  return !!id && fingerprint(deps, id) === record.fingerprint
}
