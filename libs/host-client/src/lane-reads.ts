import type { CallErrorCode, HostFrame } from '@phosphor/shared/host-protocol'

type Result = Extract<HostFrame, { type: 'result' }>
type Caller = { call(method: string, params: unknown): Promise<Result> }
/** A read of one lane by call, given its Host's connection. */
export type LaneRead<T> = (c: Caller, laneId: string) => Promise<T>

/** One lane's read by id: its data, or the refusal a user can act on. */
async function callLane(
  c: Caller,
  method: string,
  laneId: string,
  refusals: Partial<Record<CallErrorCode, string>>,
): Promise<unknown> {
  const result = await c.call(method, { laneId })
  if (!result.ok) throw new Error(refusals[result.error.code] ?? result.error.message)
  return result.data
}

const EXPORT_REFUSALS: Partial<Record<CallErrorCode, string>> = {
  unsupported: 'This Host cannot export lanes yet. Update the Host, then retry.',
  'too-large': 'This lane is too large to export from its Host.',
  'lane-stopped': 'Resume the lane to export it.',
  forbidden: "This device's access to the Host does not include lane control, which exports need.",
}

/** The Host exports to its own file and returns the document; no path crosses the wire. */
export async function exportLaneHtml(c: Caller, laneId: string): Promise<{ html: string }> {
  const data = await callLane(c, 'lane.exportHtml', laneId, EXPORT_REFUSALS)
  if (
    typeof data !== 'object' ||
    data === null ||
    !('html' in data) ||
    typeof data.html !== 'string'
  )
    throw new Error('The Host sent no export.')
  return { html: data.html }
}

const HISTORY_REFUSALS: Partial<Record<CallErrorCode, string>> = {
  unsupported: 'This Host cannot read subagent history yet. Update the Host, then retry.',
  'too-large': "This lane's subagent history is too large to read from its Host.",
  'lane-stopped': 'Resume the lane to read its subagent history.',
}

/** The lane's subagent records on its active branch, as the Host filtered them. */
export async function laneSubagentHistory(
  c: Caller,
  laneId: string,
): Promise<{ entries: unknown[]; leafId: string | null }> {
  const data = await callLane(c, 'lane.subagentHistory', laneId, HISTORY_REFUSALS)
  if (
    typeof data !== 'object' ||
    data === null ||
    !('entries' in data) ||
    !Array.isArray(data.entries) ||
    !('leafId' in data) ||
    (data.leafId !== null && typeof data.leafId !== 'string')
  )
    throw new Error('The Host sent no subagent history.')
  return { entries: data.entries as unknown[], leafId: data.leafId }
}
