import { requireSubagentCommand } from './subagentCommands'
import { useExtensionUiStore } from '@/stores/extensionUi'
import { SUBAGENT_INSPECT_WIDGET_KEY } from './subagentRuns'

export interface SubagentInspection {
  label?: string
  status?: string
  task?: string
  finalOutput?: string
  /** `kind`/`name`/`isError` when the extension reports them; never inferred. */
  messages: { role: string; text: string; kind?: string; name?: string; isError?: boolean }[]
  truncated: boolean
}

const token = (id: string): boolean =>
  id.length > 0 && id.length <= 256 && !/\s/.test(id) && !id.startsWith('--')
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined)

/** One bounded, session-owned request. Subscribe before send: the reply is immediately retracted. */
export async function inspectSubagent(
  sessionId: string,
  runId: string,
  childId: string | undefined,
  signal: AbortSignal,
): Promise<SubagentInspection> {
  if (!token(runId) || (childId !== undefined && !token(childId)))
    throw new Error('Unsupported run identity.')
  await requireSubagentCommand(sessionId, 'subagents-inspect-rpc')
  if (signal.aborted) throw new Error('Inspection cancelled.')
  const requestId = crypto.randomUUID()
  return new Promise((resolve, reject) => {
    const finish = (error?: Error, result?: SubagentInspection): void => {
      clearTimeout(timer)
      unsubscribe()
      signal.removeEventListener('abort', abort)
      if (error) reject(error)
      else resolve(result!)
    }
    const abort = (): void => finish(new Error('Inspection cancelled.'))
    const timer = setTimeout(() => finish(new Error('Inspection timed out. Try again.')), 10_000)
    const unsubscribe = useExtensionUiStore.subscribe((state) => {
      const line = state.widgets[sessionId]?.[SUBAGENT_INSPECT_WIDGET_KEY]?.lines[0]
      const prefix = 'PI_SUBAGENT_INSPECT_JSON:'
      if (!line?.startsWith(prefix) || line.length > 70_000) return
      try {
        const r = JSON.parse(line.slice(prefix.length))
        if (!r || r.requestId !== requestId) return
        if (r.kind !== 'pi-subagents.inspect-reply' || r.version !== 1) {
          finish(new Error('Unsupported inspection reply version.'))
          return
        }
        if (r.error) {
          finish(new Error(text(r.error.message) ?? 'Inspection unavailable.'))
          return
        }
        // Nested-run inspections return the nested canonical run ID, not the root.
        if ((r.asyncId !== runId && r.asyncId !== childId) || r.childId !== childId) {
          finish(new Error('Inspection reply did not match the selected child.'))
          return
        }
        finish(undefined, {
          label: text(r.label),
          status: text(r.status),
          task: text(r.task),
          finalOutput: text(r.finalOutput),
          messages: (Array.isArray(r.messages) ? r.messages : [])
            .slice(0, 200)
            .flatMap((m: unknown) => {
              if (!m || typeof m !== 'object' || !('text' in m) || typeof m.text !== 'string')
                return []
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
            }),
          truncated: !!(r.truncated?.task || r.truncated?.messages || r.truncated?.finalOutput),
        })
      } catch {
        finish(new Error('Invalid inspection reply.'))
      }
    })
    signal.addEventListener('abort', abort, { once: true })
    // Only an advertised extension command is sent, never a model-authored command or file path.
    void window.phosphor
      .piCommand(sessionId, {
        type: 'prompt',
        message: `/subagents-inspect-rpc ${requestId} ${runId}${childId ? ` ${childId}` : ''} --lines 100`,
      })
      .then((reply) => {
        if (!reply.success) finish(new Error(reply.error ?? 'Inspection command failed.'))
      })
      .catch((error: unknown) => finish(error instanceof Error ? error : new Error(String(error))))
  })
}
