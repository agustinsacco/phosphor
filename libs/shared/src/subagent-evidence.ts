import { sessionBranch } from './session-branch'

/** Custom types pi-subagents records for its notices, questions and replies. */
export const SUBAGENT_NOTIFY_TYPE = 'subagent-notify'
export const SUBAGENT_CHILD_NOTIFY_TYPE = 'subagent-incremental-child-notify'
export const SUBAGENT_CONTROL_NOTICE_TYPE = 'subagent_control_notice'
export const SUBAGENT_STEERING_NOTICE_TYPE = 'subagent_steering_notice'
export const SUBAGENT_SUPERVISOR_REQUEST_TYPE = 'subagent_supervisor_request'
export const SUBAGENT_SUPERVISOR_REPLY_TYPE = 'subagent_supervisor_reply'
export const SUBAGENT_SLASH_RESULT_TYPE = 'subagent-slash-result'

const NOTICE_TYPES = new Set<unknown>([
  SUBAGENT_NOTIFY_TYPE,
  SUBAGENT_CHILD_NOTIFY_TYPE,
  SUBAGENT_CONTROL_NOTICE_TYPE,
  SUBAGENT_STEERING_NOTICE_TYPE,
  SUBAGENT_SUPERVISOR_REQUEST_TYPE,
  SUBAGENT_SUPERVISOR_REPLY_TYPE,
  SUBAGENT_SLASH_RESULT_TYPE,
])

export function isSubagentNotice(customType: string | undefined): boolean {
  return NOTICE_TYPES.has(customType)
}

export type SessionEntry = Record<string, unknown> & { id: string; parentId: string | null }
const record = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined
const subagentCall = (block: unknown): boolean => {
  const b = record(block)
  return b?.type === 'toolCall' && b.name === 'subagent'
}

/** One entry as subagent history reads it, or null when it holds no subagent evidence. */
function evidence(entry: SessionEntry): SessionEntry | null {
  const message = entry.type === 'message' ? record(entry.message) : entry
  if (message?.role === 'assistant' && Array.isArray(message.content)) {
    const calls = message.content.filter(subagentCall)
    return calls.length ? { ...entry, message: { ...message, content: calls } } : null
  }
  if (message?.role === 'toolResult') return message.toolName === 'subagent' ? entry : null
  return typeof message?.customType === 'string' && isSubagentNotice(message.customType)
    ? entry
    : null
}

/**
 * The entries a session's subagent history reads, from pi's `get_entries`: the
 * active branch only, assistant messages cut down to their `subagent` calls, and
 * re-chained root to leaf so a reader walks them as it walks the whole file. A Host
 * sends this instead of the session file, which can run to megabytes. Applying it
 * twice changes nothing.
 */
export function subagentEvidence(
  entries: unknown[],
  leafId: string | null,
): { entries: SessionEntry[]; leafId: string | null } {
  const valid = entries.filter((e): e is SessionEntry => {
    const entry = record(e)
    return (
      typeof entry?.id === 'string' &&
      (entry.parentId === null || typeof entry.parentId === 'string')
    )
  })
  if (leafId !== null && !valid.some((e) => e.id === leafId))
    throw new Error('The active history branch is unavailable.')
  const kept: SessionEntry[] = []
  for (const entry of sessionBranch(valid, leafId)) {
    const found = evidence(entry)
    if (found) kept.push({ ...found, parentId: kept.at(-1)?.id ?? null })
  }
  return { entries: kept, leafId: kept.at(-1)?.id ?? null }
}
