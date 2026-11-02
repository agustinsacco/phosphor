/**
 * pi-subagents' bounded, read-only view of one run. It is asked for by one fixed
 * extension command and answered on the `subagent-inspect` widget. This Mac sends the
 * prompt to pi; a Host builds it from a parsed request, so no caller text reaches pi.
 */
export const SUBAGENT_INSPECT_COMMAND = 'subagents-inspect-rpc'

export interface SubagentInspectRequest {
  /** pi-subagents' own request-id form, echoed in its reply. */
  requestId: string
  runId: string
  childId?: string
}

const REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/
/** A run or child id that stays one argument: no whitespace, and never a flag. */
const argument = (id: unknown): id is string =>
  typeof id === 'string' &&
  id.length > 0 &&
  id.length <= 256 &&
  !/\s/.test(id) &&
  !id.startsWith('--')

export function parseSubagentInspectRequest(value: unknown): SubagentInspectRequest | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const { requestId, runId, childId } = value as Record<string, unknown>
  if (typeof requestId !== 'string' || !REQUEST_ID.test(requestId) || !argument(runId)) return null
  if (childId !== undefined && !argument(childId)) return null
  return { requestId, runId, ...(childId === undefined ? {} : { childId }) }
}

/** The prompt text: the only form in which an inspection reaches pi. */
export function subagentInspectPrompt(request: SubagentInspectRequest): string {
  const target = request.childId ? `${request.runId} ${request.childId}` : request.runId
  return `/${SUBAGENT_INSPECT_COMMAND} ${request.requestId} ${target} --lines 100`
}
