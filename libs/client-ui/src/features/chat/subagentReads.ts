import { piCallInline } from '@/lib/rpc'
import { useSessionsStore } from '@/stores/sessions'
import {
  subagentInspectPrompt,
  type SubagentInspectRequest,
} from '@phosphor/shared/subagent-inspect'
import { requireSubagentCommand } from './subagentCommands'

/**
 * The Subagents pane's two reads. This Mac asks its pi. A Host lane asks its Host by
 * call: a viewer needs no control of the lane, and pi's session file stays on the Host.
 */
export const onHostLane = (sessionId: string): boolean =>
  useSessionsStore.getState().live[sessionId]?.target?.kind === 'remote'

/** The session's entries on the active branch, for `subagentHistory` to read. */
export async function readSubagentEntries(
  sessionId: string,
): Promise<{ entries: unknown[]; leafId: string | null }> {
  if (onHostLane(sessionId)) return window.phosphor.invoke('hosts:subagentHistory', sessionId)
  const reply = await piCallInline(sessionId, { type: 'get_entries' })
  if (!reply.ok) throw new Error(reply.error)
  if (!reply.data) throw new Error('Recorded history is unavailable.')
  return reply.data
}

/**
 * How this session sends an inspection, once it can: pi-subagents answers on the
 * session's `subagent-inspect` widget. Only an advertised extension command ever
 * reaches pi, never model-authored text; on a Host lane its Host checks that.
 */
export async function inspectionSender(
  sessionId: string,
): Promise<(request: SubagentInspectRequest) => Promise<void>> {
  if (onHostLane(sessionId))
    return async (request) => {
      await window.phosphor.invoke('hosts:subagentInspect', sessionId, request)
    }
  await requireSubagentCommand(sessionId, 'subagents-inspect-rpc')
  return async (request) => {
    const message = subagentInspectPrompt(request)
    const reply = await piCallInline(sessionId, { type: 'prompt', message })
    if (!reply.ok) throw new Error(reply.error)
  }
}
