import {
  parseRoutineHistory,
  ROUTINE_LIMITS,
  type RemoteRoutineRun,
} from '@phosphor/shared/host-protocol-routines'
import { isUuid } from '@phosphor/shared/control-api'
import { machineRecord } from '@phosphor/shared/host-protocol-machine'
import { opsRun } from '../ops'
import type { Connection } from './state'

/** Only the owner's socket asks for linked output. The legacy history parser stays exact. */
export async function readRunPage(
  connection: Connection,
  args: { id?: string; offset?: unknown },
  legacy: () => Promise<unknown>,
): Promise<Array<RemoteRoutineRun & { outputLaneId?: string }> | null> {
  const view = connection.snapshot()
  if (!view.ownerLocal || !view.ops) return parseRoutineHistory(await legacy())
  const result = await opsRun(
    connection,
    { op: args.id ? 'routine.history' : 'routine.activity', args },
    { write: false },
  )
  if (result.status !== 'ok') return parseRoutineHistory(await legacy())
  const data = result.data
  if (!Array.isArray(data) || data.length > ROUTINE_LIMITS.history) return null
  const rows = []
  for (const value of data) {
    if (!machineRecord(value)) return null
    const { laneRef, ...raw } = value
    const row = parseRoutineHistory([raw])?.[0]
    if (!row) return null
    // Navigation always stays on the connection that answered. Its canonical
    // ref may use the machine's enrolled alias rather than its socket id.
    const id = typeof laneRef === 'string' && /^host:[^/]+\/lane:([^/]+)$/.exec(laneRef)?.[1]
    rows.push(id && isUuid(id) ? { ...row, outputLaneId: id } : row)
  }
  return rows
}
