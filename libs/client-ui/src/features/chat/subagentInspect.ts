import { parseSubagentInspectRequest } from '@phosphor/shared/subagent-inspect'
import { useExtensionUiStore } from '@/stores/extensionUi'
import { SUBAGENT_INSPECT_WIDGET_KEY } from './subagentRuns'
import { inspectionSender } from './subagentReads'

export interface SubagentInspection {
  label?: string
  status?: string
  task?: string
  finalOutput?: string
  /** `kind`/`name`/`isError` when the extension reports them; never inferred. */
  messages: { role: string; text: string; kind?: string; name?: string; isError?: boolean }[]
  truncated: boolean
}

const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)

function inspectedMessages(value: unknown): SubagentInspection['messages'] {
  return (Array.isArray(value) ? value : []).slice(0, 200).flatMap((m: unknown) => {
    if (!m || typeof m !== 'object' || !('text' in m) || typeof m.text !== 'string') return []
    const record = m as Record<string, unknown>
    const kind = text(record.kind)
    const name = text(record.name)
    return [
      {
        role: text(record.role) ?? 'message',
        text: m.text,
        ...(kind ? { kind } : {}),
        ...(name ? { name } : {}),
        ...(record.isError === true ? { isError: true } : {}),
      },
    ]
  })
}

/** pi-subagents' reply as parsed JSON: every field is checked before use. */
interface InspectReply {
  requestId?: unknown
  kind?: unknown
  version?: unknown
  error?: { message?: unknown }
  asyncId?: unknown
  childId?: unknown
  label?: unknown
  status?: unknown
  task?: unknown
  finalOutput?: unknown
  messages?: unknown
  truncated?: { task?: unknown; messages?: unknown; finalOutput?: unknown }
}

/** A correlated reply's inspection, or why it cannot be used. */
function inspectionReply(
  r: InspectReply,
  runId: string,
  childId?: string,
): SubagentInspection | Error {
  if (r.kind !== 'pi-subagents.inspect-reply' || r.version !== 1)
    return new Error('Unsupported inspection reply version.')
  if (r.error) return new Error(text(r.error.message) ?? 'Inspection unavailable.')
  // Nested-run inspections return the nested canonical run ID, not the root.
  if ((r.asyncId !== runId && r.asyncId !== childId) || r.childId !== childId)
    return new Error('Inspection reply did not match the selected child.')
  return {
    label: text(r.label),
    status: text(r.status),
    task: text(r.task),
    finalOutput: text(r.finalOutput),
    messages: inspectedMessages(r.messages),
    truncated: !!(r.truncated?.task || r.truncated?.messages || r.truncated?.finalOutput),
  }
}

/** One bounded, session-owned request. Subscribe before send: the reply is immediately retracted. */
export async function inspectSubagent(
  sessionId: string,
  runId: string,
  childId: string | undefined,
  signal: AbortSignal,
): Promise<SubagentInspection> {
  const request = parseSubagentInspectRequest({ requestId: crypto.randomUUID(), runId, childId })
  if (!request) throw new Error('Unsupported run identity.')
  const send = await inspectionSender(sessionId)
  if (signal.aborted) throw new Error('Inspection cancelled.')
  return new Promise((resolve, reject) => {
    const finish = (outcome: SubagentInspection | Error): void => {
      clearTimeout(timer)
      unsubscribe()
      signal.removeEventListener('abort', abort)
      if (outcome instanceof Error) reject(outcome)
      else resolve(outcome)
    }
    const abort = (): void => finish(new Error('Inspection cancelled.'))
    const timer = setTimeout(() => finish(new Error('Inspection timed out. Try again.')), 10_000)
    const unsubscribe = useExtensionUiStore.subscribe((state) => {
      const line = state.widgets[sessionId]?.[SUBAGENT_INSPECT_WIDGET_KEY]?.lines[0]
      const prefix = 'PI_SUBAGENT_INSPECT_JSON:'
      if (!line?.startsWith(prefix) || line.length > 70_000) return
      try {
        const r = JSON.parse(line.slice(prefix.length)) as InspectReply | null
        if (r && r.requestId === request.requestId) finish(inspectionReply(r, runId, childId))
      } catch {
        finish(new Error('Invalid inspection reply.'))
      }
    })
    signal.addEventListener('abort', abort, { once: true })
    send(request).catch((error: unknown) =>
      finish(error instanceof Error ? error : new Error(String(error))),
    )
  })
}
