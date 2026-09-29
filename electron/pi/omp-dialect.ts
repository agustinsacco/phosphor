/**
 * omp's RPC dialect, translated to and from pi's.
 *
 * omp (oh-my-pi, `@oh-my-pi/pi-coding-agent`) is a pi fork that keeps pi's
 * command family but not all of its wire. Everything above `PiRpcClient` —
 * the renderer, the session activity tracker, the command probe — speaks pi's
 * protocol as mirrored in `shared/rpc.ts`, so the differences are absorbed
 * here, in the one client that talks to the subprocess, instead of being
 * special-cased at every reader.
 *
 * Mirrored from omp's own contract, verified against omp 18.4.2 with a live
 * `omp --mode rpc` (no prompt sent): `omp://rpc.md` and
 * `packages/coding-agent/src/modes/rpc/rpc-types.ts`. When re-verifying
 * against a new omp, diff against its `rpc-mode.ts` command switch and
 * `omp --help`, and run `scripts/omp-compat.zsh`.
 *
 *   pi                      omp
 *   ----------------------  ---------------------------------------------
 *   `get_commands`          `get_available_commands` (different row shape)
 *   `fork` (entryId)        `branch` (entryId), same `{text, cancelled}`
 *   `agent_settled`         `session_settled`
 *   `agent_end.willRetry`   `agent_end.isTerminal === false`
 *   `pendingMessageCount`   `queuedMessageCount` (get_state)
 *   —                       `ready` frame first, before any response
 *   —                       protocol v2: `negotiate_protocol`, `rpc_chunk`
 *   —                       `available_commands_update`, `prompt_result`
 *   —                       subagents: `set_subagent_subscription` (sent at
 *                           startup), `subagent_*` frames, `get_subagents`
 *   a tool's updates stop   omp keeps updating a background `task` call
 *   at its end              after it ended; dropped (`OmpEndedTools`)
 *   `--session <path>`      `--resume <path>`
 *   `--fork`, `-n`,
 *   `--session-id`,
 *   `--no-context-files`    no equivalent; omp exits on an unknown flag
 *
 * Not translated, because omp has no counterpart: `clone`, `get_fork_messages`
 * (Phosphor never reads it) and `clear_queue` (Phosphor already explains an
 * `Unknown command` answer there). They reach omp as-is and fail as unknown.
 */
import type {
  PiEvent,
  RpcCommand,
  RpcResponse,
  RpcSessionState,
  RpcSlashCommand,
} from '@shared/rpc'
import type { OmpSubagentSnapshot, OmpSubagentSubscriptionLevel } from '@shared/omp-subagents'
import type { PiSpawnOptions } from './rpc-client'

/** omp's `AvailableSlashCommandSource` (`slash-commands/available-commands.ts`). */
export type OmpCommandSource = 'builtin' | 'skill' | 'extension' | 'custom' | 'mcp_prompt' | 'file'

/** One row of omp's `get_available_commands` answer (`RpcAvailableSlashCommand`). */
export interface OmpAvailableCommand {
  name: string
  aliases?: string[]
  description?: string
  input?: { hint?: string }
  subcommands?: Array<{ name: string; description?: string; usage?: string }>
  source: OmpCommandSource
}

/** The frame omp writes before it processes any command (`RpcReadyFrame`). */
export interface OmpReadyFrame {
  type: 'ready'
  protocolVersion: number
  supportedProtocolVersions?: number[]
  maxFrameBytes?: number
  maxReassembledFrameBytes?: number
}

/**
 * Which `/` menu section each omp source belongs in. Builtins and custom
 * TypeScript commands are code, like pi's extension commands; `file` commands
 * (markdown under a `commands/` dir, including Claude Code's) are prompt
 * templates in all but name; MCP prompts are prompts.
 */
const MENU_SOURCE: Record<OmpCommandSource, RpcSlashCommand['source']> = {
  builtin: 'extension',
  custom: 'extension',
  extension: 'extension',
  skill: 'skill',
  file: 'prompt',
  mcp_prompt: 'prompt',
}

/**
 * omp's command catalogue as the `/` menu's rows.
 *
 * Only builtins carry `sourceInfo`, with `source: 'omp'` so the row reads
 * "built into omp" (`originLabel`). Its path is per command, which is what
 * lets `dedupeAliases` fold a builtin's aliases — emitted as rows of their
 * own, exactly how pi reports an alias — back into the one row. `input` and
 * `subcommands` have no place in the menu and are dropped.
 */
export function ompCommandsToSlashCommands(
  commands: readonly OmpAvailableCommand[],
): RpcSlashCommand[] {
  const rows: RpcSlashCommand[] = []
  for (const command of commands) {
    const source = MENU_SOURCE[command.source] ?? 'extension'
    const base = {
      ...(command.description ? { description: command.description } : {}),
      source,
      ...(command.source === 'builtin'
        ? {
            sourceInfo: {
              path: `<omp:${command.name}>`,
              source: 'omp',
              scope: 'temporary' as const,
              origin: 'top-level' as const,
            },
          }
        : {}),
    }
    rows.push({ name: command.name, ...base })
    for (const alias of command.aliases ?? []) rows.push({ name: alias, ...base })
  }
  return rows
}

/**
 * omp's argv for `--mode rpc`, from the same options pi's argv is built from.
 *
 * Every flag here exists in `omp --help`; omp refuses to start on one it does
 * not know, so the pi-only options are left out rather than passed through.
 * A launch-time fork has no omp equivalent at all and is refused up front —
 * silently starting a fresh session in its place would look like a fork that
 * lost its history.
 */
export function ompRpcArgs(o: PiSpawnOptions): string[] {
  if (o.forkFrom) {
    throw new Error('omp cannot fork a session file at launch. Switch the agent to pi to fork it.')
  }
  const args = [...(o.prefixArgs ?? []), '--mode', 'rpc']
  if (o.sessionPath) args.push('--resume', o.sessionPath)
  if (o.model) args.push('--model', o.model)
  if (o.provider) args.push('--provider', o.provider)
  if (o.thinkingLevel) args.push('--thinking', o.thinkingLevel)
  if (o.noSession) args.push('--no-session')
  for (const ext of o.extensions ?? []) args.push('-e', ext)
  if (o.appendSystemPrompt) args.push('--append-system-prompt', o.appendSystemPrompt)
  return args
}

/**
 * The flags for a one-shot `omp -p` title run: pi's `titleArgs` minus the
 * two flags omp does not have (`--no-context-files`, `--no-prompt-templates`).
 */
export const OMP_TITLE_ARGS: readonly string[] = [
  '-p',
  '--no-session',
  '--no-tools',
  '--no-skills',
  '--no-rules',
]

/** A pi command as omp's wire needs it, and how to read omp's answer back as pi's. */
export interface OmpWireCommand {
  wire: Record<string, unknown>
  decode?: (response: RpcResponse) => RpcResponse
}

export function encodeOmpCommand(command: RpcCommand): OmpWireCommand {
  switch (command.type) {
    case 'get_commands':
      return {
        wire: { ...command, type: 'get_available_commands' },
        decode: (response) => {
          if (!response.success) return { ...response, command: 'get_commands' }
          const data = response.data
          // omp's own `RpcAvailableSlashCommand[]`; the mapping reads each row defensively.
          const rows =
            data && typeof data === 'object' && 'commands' in data && Array.isArray(data.commands)
              ? (data.commands as OmpAvailableCommand[])
              : []
          return {
            ...response,
            command: 'get_commands',
            data: { commands: ompCommandsToSlashCommands(rows) },
          }
        },
      }
    case 'fork':
      return {
        wire: { ...command, type: 'branch' },
        decode: (response) => ({ ...response, command: 'fork' }),
      }
    case 'get_state':
      return {
        wire: command,
        decode: (response) => {
          if (!response.success || !response.data) return response
          // omp's `RpcSessionState`: pi's fields plus its own; only the queue count is renamed.
          const state = response.data as RpcSessionState & { queuedMessageCount?: number }
          return {
            ...response,
            data: {
              ...state,
              pendingMessageCount: state.pendingMessageCount ?? state.queuedMessageCount ?? 0,
            },
          }
        },
      }
    default:
      return { wire: command }
  }
}

/**
 * An omp stdout record as pi would have written it, or null for one that has
 * no pi counterpart and no reader. Responses and extension UI requests pass
 * through untouched; only events differ.
 */
export function decodeOmpFrame(record: Record<string, unknown>): Record<string, unknown> | null {
  switch (record.type) {
    // `available_commands_update` is pushed at startup and after every change;
    // Phosphor asks with `get_commands` when it wants the list, so the push has
    // no reader. `prompt_result` is per-prompt completion; Phosphor follows the
    // turn from its events.
    case 'available_commands_update':
    case 'prompt_result':
      return null
    // omp's "nothing can wake this session again" — pi's `agent_settled`.
    case 'session_settled':
      return { type: 'agent_settled' } satisfies PiEvent
    // A non-terminal end means omp scheduled more work itself: pi says that
    // with `willRetry`, which is what keeps the turn visibly running.
    case 'agent_end':
      return record.isTerminal === false && record.willRetry === undefined
        ? { ...record, willRetry: true }
        : record
    default:
      return record
  }
}

// ---------------------------------------------------------------------------
// Subagents (`omp://rpc.md`, "Subagent subscriptions")
//
// omp delegates through its own `task` tool. With RPC's default of async
// execution on, a `task` call returns as soon as its agents are scheduled;
// what they do afterwards reaches a host only as subagent frames, and omp
// forwards none until asked (the level starts at `off`).

/**
 * The level every omp session subscribes at. `progress` forwards the
 * lifecycle frames (started, settled) and the coalesced `AgentProgress`
 * frames, which carry everything a sub-agent row shows: status, current tool,
 * tool count, tokens, time and the final `yield`. `events` would add every
 * session event of every subagent, streamed tokens included, and no row reads
 * them.
 */
export const OMP_SUBAGENT_LEVEL: OmpSubagentSubscriptionLevel = 'progress'

export function ompSubagentSubscriptionCommand(id: string): Record<string, unknown> {
  return { id, type: 'set_subagent_subscription', level: OMP_SUBAGENT_LEVEL }
}

/**
 * The rows of a `get_subagents` answer that name a subagent. Anything else,
 * a failure included (an omp that predates the command), reads as none.
 */
export function ompSubagentSnapshots(response: RpcResponse): OmpSubagentSnapshot[] {
  if (!response.success) return []
  const data: unknown = response.data
  const rows = data && typeof data === 'object' && 'subagents' in data ? data.subagents : undefined
  if (!Array.isArray(rows)) return []
  // Only the id is checked here; the renderer reads every other field defensively.
  return rows.filter(
    (row): row is OmpSubagentSnapshot =>
      !!row && typeof row === 'object' && 'id' in row && typeof row.id === 'string',
  )
}

/** As many ended calls as omp itself remembers subagent transcripts for. */
const MAX_ENDED_TOOLS = 256

/**
 * The tool calls omp has already ended, so a late update to one is dropped.
 *
 * A background `task` keeps calling its update callback after the call
 * returned, and omp forwards each one as `tool_execution_update` for as long
 * as the parent's run lasts (`task/index.ts` `#registerSpawnJob`). pi never
 * updates a tool after its end; the reducer would reopen the finished row as
 * running, with no second end to close it. The subagent frames carry the
 * same progress.
 */
export class OmpEndedTools {
  private readonly ended = new Set<string>()

  /** False for an update to a call that already ended. */
  admit(record: { type?: unknown; toolCallId?: unknown }): boolean {
    const id = record.toolCallId
    if (typeof id !== 'string') return true
    if (record.type === 'tool_execution_update') return !this.ended.has(id)
    if (record.type === 'tool_execution_end') {
      this.ended.add(id)
      if (this.ended.size > MAX_ENDED_TOOLS) {
        this.ended.delete(this.ended.values().next().value!)
      }
    }
    return true
  }
}

// ---------------------------------------------------------------------------
// Protocol v2 transport (`omp://rpc.md`, "Transport and Framing")
//
// On v1 omp caps every stdout line at 1 MiB and answers anything bigger with
// a failure ("RPC response exceeded the transport limit") — which is every
// `get_messages` of a long session, and paging does not help once a single
// message is large. v2 is opt-in: after `negotiate_protocol`, an oversized
// object arrives as an uninterrupted run of `rpc_chunk` frames carrying
// base64 slices of its UTF-8 JSON.

/** The protocol this client upgrades to when omp's `ready` frame offers it. */
export const OMP_PROTOCOL_V2 = 2

/** The spec's reassembly ceiling, for a `ready` frame that does not state one. */
export const OMP_DEFAULT_MAX_REASSEMBLED_BYTES = 64 * 1024 * 1024

/** The v2 command, sent before anything else once `ready` offers v2. */
export function ompNegotiateCommand(id: string): Record<string, unknown> {
  return { id, type: 'negotiate_protocol', protocolVersion: OMP_PROTOCOL_V2 }
}

/** Whether a `ready` frame offers the chunked transport. */
export function offersProtocolV2(frame: OmpReadyFrame): boolean {
  return Array.isArray(frame.supportedProtocolVersions)
    ? frame.supportedProtocolVersions.includes(OMP_PROTOCOL_V2)
    : false
}

/** A chunk sequence that broke one of the spec's MUST rules. */
export class OmpChunkError extends Error {
  override readonly name = 'OmpChunkError'
}

interface PendingChunks {
  chunkId: string
  count: number
  byteLength: number
  nextIndex: number
  chunks: Buffer[]
  receivedBytes: number
}

/** Canonical padded base64 only: `Buffer.from` would silently skip garbage. */
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/

function decodeChunkData(data: unknown): Buffer {
  if (typeof data !== 'string' || data.length === 0 || !BASE64.test(data)) {
    throw new OmpChunkError('rpc_chunk data is not base64')
  }
  const bytes = Buffer.from(data, 'base64')
  if (bytes.toString('base64') !== data) throw new OmpChunkError('rpc_chunk data is not base64')
  return bytes
}

/**
 * Reassembles `rpc_chunk` runs into the one frame they carry.
 *
 * Every rule the spec makes a MUST is enforced, and a violation is returned
 * as an `OmpChunkError` (the partial sequence is discarded, so the next run
 * starts clean): `chunkId`/`index`/`count`/`byteLength` must be well-formed and agree
 * across the run, indexes must arrive 0..count-1 with nothing in between, the
 * decoded bytes must total exactly `byteLength` and stay within the ready
 * frame's `maxReassembledFrameBytes`, and the result must be strict UTF-8
 * holding one JSON object.
 */
export class OmpChunkDecoder {
  private pending: PendingChunks | null = null
  /**
   * The run most recently rejected. Its remaining chunks are its tail, not new
   * runs, so they are discarded quietly rather than each reported again.
   */
  private abandoned: string | null = null

  constructor(private readonly maxReassembledBytes: number) {}

  /**
   * Feed one parsed stdout record.
   *
   * `frame` is what to dispatch: the record itself when it is not a chunk (an
   * interrupting frame is still a good frame), the reassembled object when a
   * run completes, or null while a run is incomplete. `error` is set when a
   * run was rejected; its partial bytes are gone.
   */
  push(record: Record<string, unknown>): {
    frame: Record<string, unknown> | null
    error?: OmpChunkError
  } {
    if (record.type !== 'rpc_chunk') {
      const pending = this.pending
      if (!pending) return { frame: record }
      this.abandon(pending.chunkId)
      return {
        frame: record,
        error: new OmpChunkError(
          `rpc_chunk sequence ${pending.chunkId} interrupted by a ${String(record.type)} frame`,
        ),
      }
    }
    if (!this.pending && record.chunkId === this.abandoned && record.index !== 0) {
      return { frame: null }
    }
    this.abandoned = null
    try {
      return { frame: this.accept(record) }
    } catch (error) {
      if (!(error instanceof OmpChunkError)) throw error
      this.abandon(typeof record.chunkId === 'string' ? record.chunkId : null)
      return { frame: null, error }
    }
  }

  private abandon(chunkId: string | null): void {
    this.pending = null
    this.abandoned = chunkId
  }

  private accept(record: Record<string, unknown>): Record<string, unknown> | null {
    const { chunkId, index, count, byteLength } = record
    if (
      typeof chunkId !== 'string' ||
      chunkId.length === 0 ||
      !Number.isSafeInteger(index) ||
      !Number.isSafeInteger(count) ||
      !Number.isSafeInteger(byteLength) ||
      (count as number) < 1 ||
      (index as number) < 0 ||
      (index as number) >= (count as number) ||
      (byteLength as number) < 1
    ) {
      throw new OmpChunkError('rpc_chunk has invalid chunkId/index/count/byteLength')
    }
    const total = byteLength as number
    if (total > this.maxReassembledBytes) {
      throw new OmpChunkError(
        `rpc_chunk sequence ${chunkId} declares ${total} bytes, over the ${this.maxReassembledBytes}-byte reassembly limit`,
      )
    }
    const bytes = decodeChunkData(record.data)

    if (!this.pending) {
      if (index !== 0)
        throw new OmpChunkError(`rpc_chunk sequence ${chunkId} did not start at index 0`)
      this.pending = {
        chunkId,
        count: count as number,
        byteLength: total,
        nextIndex: 0,
        chunks: [],
        receivedBytes: 0,
      }
    }
    const pending = this.pending
    if (pending.chunkId !== chunkId) {
      throw new OmpChunkError(`rpc_chunk sequence ${pending.chunkId} interleaved with ${chunkId}`)
    }
    if (pending.count !== count || pending.byteLength !== total) {
      throw new OmpChunkError(`rpc_chunk sequence ${chunkId} changed its count or byteLength`)
    }
    if (pending.nextIndex !== index) {
      throw new OmpChunkError(
        `rpc_chunk sequence ${chunkId} expected index ${pending.nextIndex}, got ${String(index)}`,
      )
    }
    pending.chunks.push(bytes)
    pending.receivedBytes += bytes.byteLength
    pending.nextIndex++
    if (pending.receivedBytes > pending.byteLength) {
      throw new OmpChunkError(`rpc_chunk sequence ${chunkId} exceeds its declared ${total} bytes`)
    }
    if (pending.nextIndex < pending.count) return null

    this.pending = null
    if (pending.receivedBytes !== pending.byteLength) {
      throw new OmpChunkError(
        `rpc_chunk sequence ${chunkId} carried ${pending.receivedBytes} bytes, declared ${total}`,
      )
    }
    let text: string
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(pending.chunks))
    } catch {
      throw new OmpChunkError(`rpc_chunk sequence ${chunkId} is not valid UTF-8`)
    }
    let frame: unknown
    try {
      frame = JSON.parse(text)
    } catch {
      throw new OmpChunkError(`rpc_chunk sequence ${chunkId} is not valid JSON`)
    }
    if (typeof frame !== 'object' || frame === null || Array.isArray(frame)) {
      throw new OmpChunkError(`rpc_chunk sequence ${chunkId} did not carry a JSON object`)
    }
    return frame as Record<string, unknown>
  }
}
