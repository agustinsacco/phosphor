import {
  parseRoutineHistory,
  ROUTINE_LIMITS,
  type RemoteRoutineRun,
} from '@phosphor/shared/host-protocol-routines'
import { isUuid } from '@phosphor/shared/control-api'
import { machineRecord } from '@phosphor/shared/host-protocol-machine'
import { opsRun } from '../ops'
import type { Connection } from './state'

/** Output hints travel only on an opted-in ops read. The legacy history parser stays exact. */
export async function readRunPage(
  connection: Connection,
  args: { id?: string; offset?: unknown },
  legacy: () => Promise<unknown>,
): Promise<Array<RemoteRoutineRun & { outputLaneId?: string; savedOutput?: true }> | null> {
  const view = connection.snapshot()
  if (!view.ops) return parseRoutineHistory(await legacy())
  const output = view.capabilities.includes('sessions.read')
  const op = args.id ? 'routine.history' : 'routine.activity'
  const read = (withOutput: boolean) =>
    opsRun(
      connection,
      { op, args: withOutput ? { ...args, output: true } : args },
      { write: false },
    )
  let result = await read(output)
  // The previous owner service knew laneRef but not the optional output request.
  if (output && view.ownerLocal && result.status === 'denied' && result.code === 'bad-request')
    result = await read(false)
  if (result.status !== 'ok') return parseRoutineHistory(await legacy())
  const data = result.data
  if (!Array.isArray(data) || data.length > ROUTINE_LIMITS.history) return null
  const rows = []
  for (const value of data) {
    if (!machineRecord(value)) return null
    const { laneRef, savedOutput, ...raw } = value
    if (savedOutput !== undefined && savedOutput !== true) return null
    const row = parseRoutineHistory([raw])?.[0]
    if (!row) return null
    // Navigation always stays on the connection that answered. Its canonical
    // ref may use the machine's enrolled alias rather than its socket id.
    const id = typeof laneRef === 'string' && /^host:[^/]+\/lane:([^/]+)$/.exec(laneRef)?.[1]
    rows.push(
      id && isUuid(id)
        ? { ...row, outputLaneId: id }
        : savedOutput && output
          ? { ...row, savedOutput: true as const }
          : row,
    )
  }
  return rows
}
