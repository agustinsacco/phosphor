/**
 * Artifact writes another tool made through `ctx.executeTool()`, which is how
 * `codemode` scripts call `artifact_create`, saved in the session.
 *
 * pi records nested calls only as bounded metadata on the caller's result
 * (name, status, truncated arguments, never results), so without this an
 * artifact made inside a script has no content anywhere in the session file.
 * The live pane still showed it, but every reader of the file missed it: the
 * Host's index (so a Host lane's link said it was not in the session),
 * Desktop's resume, and this extension's own rebuild.
 *
 * Each such write is saved as the `phosphor-saved-artifact` entry the snapshot
 * command already writes, which every reader understands. The save waits for
 * `turn_end`, when pi has appended the caller's tool result: an entry before it
 * would sit between the assistant's tool call and that result. Extensions see
 * `turn_end` before RPC listeners do, so the entry is on disk when clients hear
 * the turn ended.
 */
import { ARTIFACT_ENTRY_TYPE, ARTIFACT_WRITE_TOOLS } from './artifact-store'

interface NestedToolEnd {
  toolName?: string
  parentToolCallId?: string
  isError?: boolean
  result?: { details?: { id?: unknown; content?: unknown; version?: unknown } }
}

export function saveNestedArtifactWrites(pi: {
  on(event: string, handler: (event: unknown) => unknown): void
  appendEntry?(type: string, data: unknown): void
}): void {
  let pending: unknown[] = []
  pi.on('tool_execution_end', (event) => {
    const end = event as NestedToolEnd
    const details = end.result?.details
    if (
      !end.parentToolCallId ||
      end.isError ||
      !ARTIFACT_WRITE_TOOLS.includes(end.toolName ?? '') ||
      typeof details?.id !== 'string' ||
      typeof details.content !== 'string' ||
      typeof details.version !== 'number'
    )
      return
    pending.push(details)
  })
  const save = (): void => {
    const records = pending
    pending = []
    for (const record of records) pi.appendEntry?.(ARTIFACT_ENTRY_TYPE, record)
  }
  pi.on('turn_end', save)
  pi.on('agent_end', save)
}
