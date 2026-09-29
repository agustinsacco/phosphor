/**
 * omp's forwarded subagent activity: the one part of omp's RPC with no pi
 * counterpart that Phosphor renders (`omp://rpc.md`, "Subagent subscriptions").
 *
 * Mirrored from `@oh-my-pi/pi-coding-agent` 18.4.2, never imported:
 *   src/modes/rpc/rpc-types.ts        `RpcSubagentSubscriptionLevel`,
 *                                     `RpcSubagentSnapshot`, the three frames
 *   src/modes/rpc/rpc-subagents.ts    `RpcSubagentRegistry` (what is forwarded
 *                                     at which level, what `get_subagents` keeps)
 *   pi-tui src/overlays/session-observer-registry.ts
 *                                     `SubagentLifecyclePayload`,
 *                                     `SubagentProgressPayload`
 *   pi-tui src/tools/task.ts          `AgentProgress`
 *
 * Only the fields a Phosphor reader uses are declared, all optional past the
 * identity: these arrive from another process, and every reader treats them
 * as untrusted (`src/features/chat/subagentRuns.ts`). pi never sends any of
 * them, and is never asked to.
 */

export type OmpSubagentSubscriptionLevel = 'off' | 'progress' | 'events'

/** `AgentProgress['status']`. */
export type OmpAgentStatus = 'pending' | 'running' | 'completed' | 'failed' | 'aborted'

/** omp's `AgentProgress`: one subagent's running counters, rebuilt on every frame. */
export interface OmpAgentProgress {
  index: number
  id: string
  agent: string
  status: OmpAgentStatus
  description?: string
  currentTool?: string
  currentToolArgs?: string
  /** Newest first, at most five. */
  recentTools?: Array<{ tool: string; args: string; endMs: number }>
  /** Newest first, at most eight. */
  recentOutput?: string[]
  toolCount?: number
  /** Input + output + cache-write tokens across the run. */
  tokens?: number
  /** USD. */
  cost?: number
  durationMs?: number
  resolvedModel?: string
  /** Per tool name; `yield` holds the subagent's final report. */
  extractedToolData?: Record<string, unknown[]>
}

/** `SubagentLifecyclePayload`: a subagent started, or settled. */
export interface OmpSubagentLifecyclePayload {
  id: string
  agent: string
  index: number
  status: 'started' | 'completed' | 'failed' | 'aborted'
  description?: string
  sessionFile?: string
  /** The `task` call that spawned it. */
  parentToolCallId?: string
  /** A background job: the call returned while this agent kept running. */
  detached?: boolean
}

/** `SubagentProgressPayload`, coalesced by omp to at most one per 150 ms. */
export interface OmpSubagentProgressPayload {
  index: number
  agent: string
  progress: OmpAgentProgress
  parentToolCallId?: string
  sessionFile?: string
  detached?: boolean
}

export type OmpSubagentFrame =
  | { type: 'subagent_lifecycle'; payload: OmpSubagentLifecyclePayload }
  | { type: 'subagent_progress'; payload: OmpSubagentProgressPayload }
  /** Only at level `events`, which Phosphor never asks for. */
  | { type: 'subagent_event'; payload: { id: string; event: unknown } }

/**
 * One `get_subagents` row. omp's registry keeps a subagent from its `started`
 * lifecycle frame until its terminal one, so every row is one still running.
 */
export interface OmpSubagentSnapshot {
  id: string
  index: number
  agent: string
  status: OmpAgentStatus
  description?: string
  sessionFile?: string
  parentToolCallId?: string
  lastUpdate?: number
  progress?: OmpAgentProgress
}

const FRAME_TYPES: Record<OmpSubagentFrame['type'], true> = {
  subagent_lifecycle: true,
  subagent_progress: true,
  subagent_event: true,
}

export function isOmpSubagentFrame(record: { type?: unknown }): record is OmpSubagentFrame {
  return typeof record.type === 'string' && Object.hasOwn(FRAME_TYPES, record.type)
}
