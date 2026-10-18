import type { AgentMessage, Model, ThinkingLevel } from './messages'
import type { PromptDisposition, QueuedInputDisposition, QueueMode } from './commands'
import type { CompactionResult } from './events'

// ---------- responses ----------

export interface RpcSessionState {
  model?: Model | null
  thinkingLevel: ThinkingLevel
  isStreaming: boolean
  isCompacting: boolean
  steeringMode: QueueMode
  followUpMode: QueueMode
  sessionFile?: string
  sessionId: string
  sessionName?: string
  autoCompactionEnabled: boolean
  messageCount: number
  pendingMessageCount: number
}

export interface SessionStats {
  sessionFile?: string
  sessionId: string
  userMessages: number
  assistantMessages: number
  toolCalls: number
  toolResults: number
  totalMessages: number
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number }
  cost: number
  contextUsage?: {
    tokens: number | null
    contextWindow: number
    percent: number | null
  }
}

export interface BashResult {
  output: string
  exitCode: number | null
  cancelled: boolean
  truncated: boolean
  fullOutputPath?: string
}

export interface SourceInfo {
  path: string
  source: string
  scope: 'user' | 'project' | 'temporary'
  origin: 'package' | 'top-level'
  baseDir?: string
}

export interface RpcSlashCommand {
  name: string
  description?: string
  source: 'extension' | 'prompt' | 'skill'
  sourceInfo?: SourceInfo
}

interface RpcResponseBase {
  id?: string
  type: 'response'
  command: string
}

export interface RpcSuccessResponse<TData = unknown> extends RpcResponseBase {
  success: true
  data?: TData
}

export interface RpcErrorResponse extends RpcResponseBase {
  success: false
  error: string
}

export type RpcResponse<TData = unknown> = RpcSuccessResponse<TData> | RpcErrorResponse

/** Per-command response data payloads. */
export interface RpcResponseDataMap {
  prompt: { disposition: PromptDisposition }
  steer: { disposition: QueuedInputDisposition }
  follow_up: { disposition: QueuedInputDisposition }
  abort: undefined
  new_session: { cancelled: boolean }
  get_state: RpcSessionState
  set_model: Model
  cycle_model: { model: Model; thinkingLevel: ThinkingLevel; isScoped: boolean } | null
  get_available_models: { models: Model[] }
  set_thinking_level: undefined
  cycle_thinking_level: { level: ThinkingLevel } | null
  get_available_thinking_levels: { levels: ThinkingLevel[] }
  set_steering_mode: undefined
  set_follow_up_mode: undefined
  compact: CompactionResult
  set_auto_compaction: undefined
  set_auto_retry: undefined
  abort_retry: undefined
  bash: BashResult
  abort_bash: undefined
  get_session_stats: SessionStats
  export_html: { path: string }
  switch_session: { cancelled: boolean }
  fork: { text: string; cancelled: boolean }
  clone: { cancelled: boolean }
  get_fork_messages: { messages: Array<{ entryId: string; text: string }> }
  get_last_assistant_text: { text: string | null }
  set_session_name: undefined
  get_messages: { messages: AgentMessage[] }
  get_commands: { commands: RpcSlashCommand[] }
  /**
   * Entry and tree node shapes live in pi's session-format spec and are
   * deliberately not mirrored here: no surface renders them yet, and
   * half-mirroring a recursive on-disk format is how specs drift from code.
   * Declare a surface needs them before filling these in.
   */
  get_entries: { entries: unknown[]; leafId: string | null }
  get_tree: { tree: unknown[]; leafId: string | null }
  clear_queue: { steering: string[]; followUp: string[] }
}
