/**
 * Chat view-model types: what the chat surface renders, as opposed to the raw
 * pi protocol shapes in `@shared/rpc`.
 */
import type {
  CompactionReason,
  ImageContent,
  StopReason,
  ToolPartialResult,
  Usage,
} from '@shared/rpc'
import type { OmpSubagentLive } from './subagentRuns'

export interface UserItem {
  id: string
  kind: 'user'
  text: string
  images?: ImageContent[]
  /** True when added locally before pi echoes it back. */
  optimistic?: boolean
  /** Unix ms from the AgentMessage, or local time for optimistic items. */
  timestamp?: number
}

export type AssistantBlock =
  | { type: 'text'; index: number; text: string; closed: boolean }
  | {
      type: 'thinking'
      index: number
      text: string
      closed: boolean
      /**
       * Local ms when the block appeared and when it ended, for "Thought for
       * 12s". Only a thought that streamed in this window has them: pi's
       * session file records no timing, so history shows "Thought".
       */
      startedAt?: number
      endedAt?: number
    }
  | { type: 'tool'; index: number; toolCallId: string }

export interface AssistantItem {
  id: string
  kind: 'assistant'
  blocks: AssistantBlock[]
  streaming: boolean
  stopReason?: StopReason
  errorMessage?: string
  usage?: Usage
  model?: string
  /** Unix ms from the AgentMessage. */
  timestamp?: number
}

export interface BashItem {
  id: string
  kind: 'bash'
  command: string
  output: string
  exitCode: number | null
  running: boolean
  truncated: boolean
  fullOutputPath?: string | null
  excludeFromContext?: boolean
}

export interface DividerItem {
  id: string
  kind: 'divider'
  variant: 'compaction' | 'branchSummary' | 'error'
  summary?: string
  tokensBefore?: number
  reason?: CompactionReason
}

/**
 * Extension-injected message (`custom` / `customMessage` roles).
 * `inContext` mirrors pi's distinction: `custom_message` entries participate
 * in the LLM context, plain `custom` entries are extension state only.
 */
export interface CustomItem {
  id: string
  kind: 'custom'
  customType?: string
  text: string
  images?: ImageContent[]
  inContext: boolean
  /**
   * The extension asked for it to be hidden (`display: false`). Kept only for
   * the sub-agent completion, which pi-subagents mutes on success so its TUI
   * does not badge an idle tab; here it is the visible cause of the reply
   * that follows it.
   */
  quiet?: boolean
}

export type ChatItem = UserItem | AssistantItem | BashItem | DividerItem | CustomItem

export type ToolStatus = 'starting' | 'running' | 'done' | 'error'

export interface ToolState {
  toolCallId: string
  /**
   * `null` while a tool call streams under a provider that withholds its
   * identity (see toolIdentity.ts) — render that state as "preparing", never
   * as a literal tool name.
   */
  toolName: string | null
  /** Final validated args (from tool_execution_start), else parsed-from-stream. */
  args?: Record<string, unknown>
  /** Raw streamed JSON args text while the toolcall block is open. */
  argsText: string
  status: ToolStatus
  /** Accumulated partial output; replaced wholesale on every update. */
  output: ToolPartialResult | null
  result?: ToolPartialResult
  isError?: boolean
  startedAt?: number
  endedAt?: number
  /**
   * omp only: the subagents this `task` call spawned, by id, as omp's
   * subagent frames last described them. Outlives the call's own end, since a
   * background spawn keeps running after it (`subagentRuns.ts`).
   */
  subagents?: Record<string, OmpSubagentLive>
}

interface RetryState {
  attempt: number
  maxAttempts: number
  delayMs: number
  errorMessage: string
}

export interface ChatSessionState {
  items: ChatItem[]
  tools: Record<string, ToolState>
  isStreaming: boolean
  isCompacting: boolean
  /** Wall-clock ms when the current agent run started; null while idle. */
  agentStartedAt: number | null
  /**
   * Wall-clock ms when a prompt was handed to pi, cleared the moment pi says
   * anything back (`agent_start`, or the run ending without ever starting).
   *
   * Set AND unset without an agent event of its own, because the whole point
   * is the window where pi has emitted nothing: provider spawn, session
   * resume, first byte from the model. That window is what the booting
   * indicator covers.
   */
  promptSentAt: number | null
  queues: { steering: string[]; followUp: string[] }
  retry: RetryState | null
  /** Transport-level error (pi crashed / spawn failed). */
  error: string | null
}

export const emptyChatSession = (): ChatSessionState => ({
  items: [],
  tools: {},
  isStreaming: false,
  isCompacting: false,
  agentStartedAt: null,
  promptSentAt: null,
  queues: { steering: [], followUp: [] },
  retry: null,
  error: null,
})

let nextId = 1
export const newItemId = (): string => `ci-${nextId++}`
