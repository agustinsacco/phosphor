import type { CallErrorCode, HostFrame } from '@phosphor/shared/host-protocol'

type Result = Extract<HostFrame, { type: 'result' }>

const REFUSALS: Partial<Record<CallErrorCode, string>> = {
  unsupported: 'This Host cannot export lanes yet. Update the Host, then retry.',
  'too-large': 'This lane is too large to export from its Host.',
  'lane-stopped': 'Resume the lane to export it.',
  forbidden: "This device's access to the Host does not include lane control, which exports need.",
}

/** The Host exports to its own file and returns the document; no path crosses the wire. */
export async function exportLaneHtml(
  c: { call(method: string, params: unknown): Promise<Result> },
  laneId: string,
): Promise<{ html: string }> {
  const result = await c.call('lane.exportHtml', { laneId })
  if (!result.ok) throw new Error(REFUSALS[result.error.code] ?? result.error.message)
  const data: unknown = result.data
  if (
    typeof data !== 'object' ||
    data === null ||
    !('html' in data) ||
    typeof data.html !== 'string'
  )
    throw new Error('The Host sent no export.')
  return { html: data.html }
}
