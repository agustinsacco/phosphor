/**
 * Artifact writes: storing the next version, and keeping the ones no tool result carries.
 *
 * `createArtifactCommit` is the one place every artifact write passes through: a
 * model-issued call, a `codemode` script's `tools.artifact_create`, a sub-agent's. A
 * model's call reaches the session file as its own `toolResult` entry, which every
 * reader of the file understands. A script's call does not: it runs through
 * `ctx.executeTool()`, and pi keeps nested calls only as bounded metadata on the
 * script's result, never their results. Without this, an artifact made inside a script
 * has no content in the session file, so the live pane shows it while every reader of
 * the file misses it: the Host's index (a Host lane's link then says the artifact is
 * not in the session), Desktop's resume, and this extension's own rebuild.
 *
 * Two independent signals spot such a write, because one signal with no fallback and
 * no failure path is what let those writes go missing in silence: the
 * `<caller id>/<n>` tool-call id pi gives a call another tool made, and pi's
 * `tool_execution_end`, which names the caller in `parentToolCallId`. Both key on the
 * tool-call id, so a write is kept once whichever fires, and the appended
 * `phosphor-saved-artifact` entry carries it so the indexer folds it against a tool
 * result of the same call.
 *
 * The append waits for `turn_end`, when pi has appended the script's result: an entry
 * before it would sit between the assistant's tool call and that result. Extensions see
 * `turn_end` before RPC listeners do, so the entry is on disk when clients hear the turn
 * ended. Imports resolve against pi's own runtime when it loads the extension.
 */
import { ARTIFACT_ENTRY_TYPE, ARTIFACT_WRITE_TOOLS } from './artifact-store'

export interface ArtifactDetails {
  id: string
  title: string
  type: string
  language?: string
  content: string
  version: number
  /** Set by `artifact_create({ from })`: the ref the content was copied from. */
  derivedFrom?: string
}

export interface ToolResultLike {
  content: Array<{ type: 'text'; text: string }>
  details: ArtifactDetails
}

/** The write a `tool_execution_end` reports: unvalidated JSON until checked. */
interface NestedToolEnd {
  toolCallId?: unknown
  toolName?: string
  parentToolCallId?: string
  isError?: boolean
  result?: { details?: Partial<ArtifactDetails> }
}

interface PiHooks {
  on(event: string, handler: (event: unknown) => unknown): void
  appendEntry?(type: string, data: unknown): void
}

/** pi's id for a call another tool made: `<calling tool call id>/<n>`; no slash otherwise. */
function isNestedToolCallId(toolCallId: string): boolean {
  return toolCallId.includes('/')
}

/**
 * The function that stores a write and answers with its tool result, keeping a
 * script's write for the session file. `artifacts` is the live map the tools edit.
 */
export function createArtifactCommit(
  pi: PiHooks,
  artifacts: Map<string, ArtifactDetails>,
): (record: ArtifactDetails, text: string, toolCallId?: string) => ToolResultLike {
  /** Scripted writes awaiting their turn's end, keyed by the call that made them. */
  const pending = new Map<string, ArtifactDetails>()
  const keep = (toolCallId: string, record: ArtifactDetails): void => {
    if (!pending.has(toolCallId)) pending.set(toolCallId, record)
  }

  pi.on('tool_execution_end', (event) => {
    const end = event as NestedToolEnd
    const details = end.result?.details
    if (
      !end.parentToolCallId ||
      end.isError ||
      typeof end.toolCallId !== 'string' ||
      !ARTIFACT_WRITE_TOOLS.includes(end.toolName ?? '') ||
      typeof details?.id !== 'string' ||
      typeof details.content !== 'string' ||
      typeof details.version !== 'number'
    )
      return
    keep(end.toolCallId, details as ArtifactDetails)
  })

  const flush = (): void => {
    for (const [toolCallId, record] of [...pending]) {
      pending.delete(toolCallId)
      try {
        pi.appendEntry?.(ARTIFACT_ENTRY_TYPE, { ...record, toolCallId })
      } catch (error) {
        // The turn is over, so nothing can tell the model: say it where the debug log
        // will see it rather than leave a write that only ever lived in memory.
        console.error(
          `[Phosphor] could not save a scripted artifact write (${toolCallId}) to the session file: ${
            error instanceof Error ? error.message : String(error)
          }`,
        )
      }
    }
  }
  pi.on('turn_end', flush)
  pi.on('agent_end', flush)

  return (record, text, toolCallId) => {
    if (toolCallId && isNestedToolCallId(toolCallId)) {
      // A Pi that cannot append entries cannot make this durable, and a result that
      // reads as success would send the model off to link an artifact nothing keeps.
      if (typeof pi.appendEntry !== 'function')
        throw new Error(
          'This Pi cannot save an artifact a script wrote, so nothing was created. ' +
            'Call the artifact tool directly instead of through codemode.',
        )
      keep(toolCallId, record)
    }
    artifacts.set(record.id, record)
    return { content: [{ type: 'text', text }], details: record }
  }
}
