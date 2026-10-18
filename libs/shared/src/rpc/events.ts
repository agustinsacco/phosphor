import type {
  AgentMessage,
  AssistantMessage,
  ImageContent,
  TextContent,
  ToolCallContent,
  ToolResultMessage,
  Usage,
} from './messages'

// ---------- assistant streaming deltas ----------

export type AssistantMessageEvent =
  | { type: 'start' }
  | { type: 'text_start'; contentIndex: number }
  | { type: 'text_delta'; contentIndex: number; delta: string }
  | { type: 'text_end'; contentIndex: number; content?: string }
  | { type: 'thinking_start'; contentIndex: number }
  | { type: 'thinking_delta'; contentIndex: number; delta: string }
  | { type: 'thinking_end'; contentIndex: number; content?: string }
  /**
   * Tool-call id + name ride directly on this event from pi 0.84.3, which is
   * how identity reaches the UI before the argument payload finishes streaming.
   * Absent on older pi, where it only arrives at `toolcall_end`.
   */
  | {
      type: 'toolcall_start'
      contentIndex: number
      id?: string
      toolName?: string
    }
  | { type: 'toolcall_delta'; contentIndex: number; delta: string }
  | { type: 'toolcall_end'; contentIndex: number; toolCall?: ToolCallContent }
  | { type: 'done'; reason: 'stop' | 'length' | 'toolUse'; message?: AssistantMessage }
  | { type: 'error'; reason: 'aborted' | 'error'; error?: unknown; message?: AssistantMessage }

// ---------- events (stdout stream, no `id`) ----------

export interface ToolPartialResult {
  content: (TextContent | ImageContent)[]
  details?: unknown
}

export type PiEvent =
  | { type: 'agent_start' }
  | { type: 'agent_end'; messages: AgentMessage[]; willRetry?: boolean }
  /** `aborted` is true when the run ended because it was aborted. */
  | { type: 'agent_settled'; aborted: boolean }
  | { type: 'turn_start' }
  | { type: 'turn_end'; message: AgentMessage; toolResults: ToolResultMessage[] }
  | { type: 'message_start'; message: AgentMessage }
  /**
   * Carries no `message` (pi's `toJsonEvent` removed the cumulative snapshot);
   * `usage` is cumulative-as-of the delta and is absent on pi < 0.84.2.
   */
  | { type: 'message_update'; usage?: Usage; assistantMessageEvent: AssistantMessageEvent }
  | { type: 'message_end'; message: AgentMessage }
  /**
   * Tool execution events. `parentToolCallId` marks a call another tool made
   * while it ran (a codemode script calling tools); it is not a block of any
   * assistant message, and the parent's result records it in `nestedCalls`.
   */
  | {
      type: 'tool_execution_start'
      toolCallId: string
      toolName: string
      args: Record<string, unknown>
      parentToolCallId?: string
    }
  | {
      type: 'tool_execution_update'
      toolCallId: string
      toolName: string
      args: Record<string, unknown>
      partialResult: ToolPartialResult
      parentToolCallId?: string
    }
  | {
      type: 'tool_execution_end'
      toolCallId: string
      toolName: string
      result: ToolPartialResult
      isError: boolean
      parentToolCallId?: string
      /** How long `execute()` took (monotonic); absent when the tool did not run. */
      durationMs?: number
    }
  | { type: 'queue_update'; steering: string[]; followUp: string[] }
  | { type: 'compaction_start'; reason: CompactionReason }
  | {
      type: 'compaction_end'
      reason: CompactionReason
      result: CompactionResult | null
      aborted: boolean
      willRetry?: boolean
      errorMessage?: string
    }
  | {
      type: 'auto_retry_start'
      attempt: number
      maxAttempts: number
      delayMs: number
      errorMessage: string
    }
  | { type: 'auto_retry_end'; success: boolean; attempt: number; finalError?: string }
  /** Output chunk from a direct RPC `bash` command, not a tool execution. */
  | { type: 'bash_execution_update'; id?: string; delta: string }
  | {
      type: 'summarization_retry_scheduled'
      attempt: number
      maxAttempts: number
      delayMs: number
      errorMessage: string
    }
  | { type: 'summarization_retry_attempt_start'; source: 'branchSummary' }
  | {
      type: 'summarization_retry_attempt_start'
      source: 'compaction'
      reason: CompactionReason
    }
  | { type: 'summarization_retry_finished' }
  | { type: 'extension_error'; extensionPath?: string; event?: string; error: string }

export type CompactionReason = 'manual' | 'threshold' | 'overflow'

export interface CompactionResult {
  summary: string
  firstKeptEntryId: string
  tokensBefore: number
  details?: unknown
}
