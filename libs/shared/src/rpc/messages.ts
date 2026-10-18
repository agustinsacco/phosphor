// ---------- content blocks ----------

export interface TextContent {
  type: 'text'
  text: string
}

export interface ImageContent {
  type: 'image'
  data: string
  mimeType: string
}

export interface ThinkingContent {
  type: 'thinking'
  thinking: string
}

export interface ToolCallContent {
  type: 'toolCall'
  id: string
  name: string
  arguments: Record<string, unknown>
}

export type AssistantContentBlock = TextContent | ThinkingContent | ToolCallContent
export type UserContentBlock = TextContent | ImageContent

// ---------- models ----------

/**
 * Ascending order of effort. `max` is real — pi's `EXTENDED_THINKING_LEVELS`
 * and `--thinking` arg validator both accept it, and 98 catalogued models
 * support it. Omitting it made those models unable to reach their top level.
 */
export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/**
 * Per-model mapping of pi's thinking levels onto provider-specific values.
 *
 * The tri-state is the whole point, so it must not be collapsed to a boolean:
 *   - a string/number value → supported, sent as that value
 *   - `null`               → explicitly NOT supported
 *   - key absent           → provider default for `off…high`, but
 *                            NOT supported for `xhigh`/`max`
 *
 * See `shared/thinking.ts`, which implements those rules.
 */
export type ThinkingLevelMap = Partial<Record<ThinkingLevel, string | null>>

export interface ModelCost {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export interface Model {
  id: string
  name: string
  api: string
  provider: string
  baseUrl?: string
  /**
   * Whether the model reasons at all. Necessary but NOT sufficient for showing
   * a thinking picker — consult `thinkingLevelMap` via
   * `supportedThinkingLevels()` for *which* levels are selectable.
   */
  reasoning: boolean
  /** Absent or null when the model has no level overrides. */
  thinkingLevelMap?: ThinkingLevelMap | null
  input: string[]
  contextWindow: number
  maxTokens: number
  cost: ModelCost
  [key: string]: unknown
}

// ---------- messages ----------

export type StopReason = 'stop' | 'length' | 'toolUse' | 'error' | 'aborted'

export interface Usage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  /**
   * pi's own total (its `calculateContextTokens` prefers this over the sum),
   * present on the wire since usage returned to `message_update` in 0.84.2.
   * Optional here because older persisted messages predate it.
   */
  totalTokens?: number
  cost?: {
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
    total: number
  }
}

export interface UserMessage {
  role: 'user'
  content: string | UserContentBlock[]
  timestamp?: number
  attachments?: unknown[]
}

export interface AssistantMessage {
  role: 'assistant'
  content: AssistantContentBlock[]
  api?: string
  provider?: string
  model?: string
  usage?: Usage
  stopReason?: StopReason
  errorMessage?: string
  timestamp?: number
}

export interface ToolResultMessage {
  role: 'toolResult'
  toolCallId: string
  toolName: string
  content: (TextContent | ImageContent)[]
  details?: unknown
  isError: boolean
  timestamp?: number
  /** Milliseconds the execution took (monotonic); absent for legacy results. */
  durationMs?: number
}

export interface BashExecutionMessage {
  role: 'bashExecution'
  command: string
  output: string
  exitCode: number | null
  cancelled: boolean
  truncated: boolean
  fullOutputPath?: string | null
  excludeFromContext?: boolean
  timestamp?: number
}

/** Extension-injected messages and other roles that may appear in history. */
export interface CustomMessage {
  role: 'custom' | 'customMessage'
  customType?: string
  content?: unknown
  display?: boolean
  details?: unknown
  timestamp?: number
  [key: string]: unknown
}

export interface BranchSummaryMessage {
  role: 'branchSummary'
  summary: string
  fromId?: string
  timestamp?: number
  [key: string]: unknown
}

export interface CompactionSummaryMessage {
  role: 'compactionSummary'
  summary: string
  tokensBefore?: number
  timestamp?: number
  [key: string]: unknown
}

export type AgentMessage =
  | UserMessage
  | AssistantMessage
  | ToolResultMessage
  | BashExecutionMessage
  | CustomMessage
  | BranchSummaryMessage
  | CompactionSummaryMessage
