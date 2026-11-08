import type { ImageContent, ThinkingLevel } from './messages'

// ---------- commands (stdin) ----------

/**
 * What pi did with a submitted input. `handled`: an extension command or input
 * handler consumed it and no run started for it, so no `agent_settled` will
 * follow on its account. `queued`: it joins the running run. `started`: pi
 * accepted it to start a run. It describes this input only, not other work an
 * extension may start.
 */
export type QueuedInputDisposition = 'handled' | 'queued'
export type PromptDisposition = QueuedInputDisposition | 'started'

export type StreamingBehavior = 'steer' | 'followUp'
export type QueueMode = 'all' | 'one-at-a-time'

export type RpcCommand =
  | {
      id?: string
      type: 'prompt'
      message: string
      images?: ImageContent[]
      streamingBehavior?: StreamingBehavior
    }
  | { id?: string; type: 'steer'; message: string; images?: ImageContent[] }
  | { id?: string; type: 'follow_up'; message: string; images?: ImageContent[] }
  | { id?: string; type: 'abort' }
  | { id?: string; type: 'new_session'; parentSession?: string }
  | { id?: string; type: 'get_state' }
  | { id?: string; type: 'set_model'; provider: string; modelId: string }
  | { id?: string; type: 'cycle_model' }
  | { id?: string; type: 'get_available_models' }
  | { id?: string; type: 'set_thinking_level'; level: ThinkingLevel }
  | { id?: string; type: 'cycle_thinking_level' }
  /** Levels the *current* model supports. Authoritative; prefer over inference. */
  | { id?: string; type: 'get_available_thinking_levels' }
  | { id?: string; type: 'set_steering_mode'; mode: QueueMode }
  | { id?: string; type: 'set_follow_up_mode'; mode: QueueMode }
  | { id?: string; type: 'compact'; customInstructions?: string }
  | { id?: string; type: 'set_auto_compaction'; enabled: boolean }
  | { id?: string; type: 'set_auto_retry'; enabled: boolean }
  | { id?: string; type: 'abort_retry' }
  | { id?: string; type: 'bash'; command: string; excludeFromContext?: boolean }
  | { id?: string; type: 'abort_bash' }
  | { id?: string; type: 'get_session_stats' }
  | { id?: string; type: 'export_html'; outputPath?: string }
  | { id?: string; type: 'switch_session'; sessionPath: string }
  | { id?: string; type: 'fork'; entryId: string }
  | { id?: string; type: 'clone' }
  | { id?: string; type: 'get_fork_messages' }
  | { id?: string; type: 'get_last_assistant_text' }
  | { id?: string; type: 'set_session_name'; name: string }
  | { id?: string; type: 'get_messages' }
  | { id?: string; type: 'get_commands' }
  /** Branch-jump tree. `since` returns only entries appended after that id. */
  | { id?: string; type: 'get_entries'; since?: string }
  | { id?: string; type: 'get_tree' }
  /** Drains and returns the pending steering/follow-up queues (pi 0.84.4+). */
  | { id?: string; type: 'clear_queue' }

export type RpcCommandType = RpcCommand['type']
