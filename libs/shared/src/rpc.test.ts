import { describe, expect, expectTypeOf, it } from 'vitest'
import type * as Rpc from './rpc'

// Frozen public-entry fixtures: internal agreement is not upstream pi verification.
type ExpectedCommand =
  | {
      id?: string
      type: 'prompt'
      message: string
      images?: Rpc.ImageContent[]
      streamingBehavior?: Rpc.StreamingBehavior
    }
  | { id?: string; type: 'steer'; message: string; images?: Rpc.ImageContent[] }
  | { id?: string; type: 'follow_up'; message: string; images?: Rpc.ImageContent[] }
  | { id?: string; type: 'abort' }
  | { id?: string; type: 'new_session'; parentSession?: string }
  | { id?: string; type: 'get_state' }
  | { id?: string; type: 'set_model'; provider: string; modelId: string }
  | { id?: string; type: 'cycle_model' }
  | { id?: string; type: 'get_available_models' }
  | { id?: string; type: 'set_thinking_level'; level: Rpc.ThinkingLevel }
  | { id?: string; type: 'cycle_thinking_level' }
  /** Levels the *current* model supports. Authoritative; prefer over inference. */
  | { id?: string; type: 'get_available_thinking_levels' }
  | { id?: string; type: 'set_steering_mode'; mode: Rpc.QueueMode }
  | { id?: string; type: 'set_follow_up_mode'; mode: Rpc.QueueMode }
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

interface ExpectedResponses {
  prompt: { disposition: Rpc.PromptDisposition }
  steer: { disposition: Rpc.QueuedInputDisposition }
  follow_up: { disposition: Rpc.QueuedInputDisposition }
  abort: undefined
  new_session: { cancelled: boolean }
  get_state: Rpc.RpcSessionState
  set_model: Rpc.Model
  cycle_model: { model: Rpc.Model; thinkingLevel: Rpc.ThinkingLevel; isScoped: boolean } | null
  get_available_models: { models: Rpc.Model[] }
  set_thinking_level: undefined
  cycle_thinking_level: { level: Rpc.ThinkingLevel } | null
  get_available_thinking_levels: { levels: Rpc.ThinkingLevel[] }
  set_steering_mode: undefined
  set_follow_up_mode: undefined
  compact: Rpc.CompactionResult
  set_auto_compaction: undefined
  set_auto_retry: undefined
  abort_retry: undefined
  bash: Rpc.BashResult
  abort_bash: undefined
  get_session_stats: Rpc.SessionStats
  export_html: { path: string }
  switch_session: { cancelled: boolean }
  fork: { text: string; cancelled: boolean }
  clone: { cancelled: boolean }
  get_fork_messages: { messages: Array<{ entryId: string; text: string }> }
  get_last_assistant_text: { text: string | null }
  set_session_name: undefined
  get_messages: { messages: Rpc.AgentMessage[] }
  get_commands: { commands: Rpc.RpcSlashCommand[] }
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

describe('RPC public mirror characterization', () => {
  it('preserves the exact command union and response associations', () => {
    expectTypeOf<Rpc.RpcCommand>().toEqualTypeOf<ExpectedCommand>()
    expectTypeOf<Rpc.RpcCommandType>().toEqualTypeOf<ExpectedCommand['type']>()
    expectTypeOf<Rpc.RpcResponseDataMap>().toEqualTypeOf<ExpectedResponses>()
    expectTypeOf<Rpc._NoMissingResponseKeys>().toEqualTypeOf<never>()
    expectTypeOf<Rpc._NoExtraResponseKeys>().toEqualTypeOf<never>()
  })

  it('preserves prompt dispositions and legacy optional delta fields', () => {
    expectTypeOf<Rpc.PromptDisposition>().toEqualTypeOf<'handled' | 'queued' | 'started'>()
    expectTypeOf<Rpc.QueuedInputDisposition>().toEqualTypeOf<'handled' | 'queued'>()
    const deltas: Rpc.AssistantMessageEvent[] = [
      { type: 'toolcall_start', contentIndex: 0 },
      { type: 'toolcall_start', contentIndex: 0, id: 'call', toolName: 'read' },
      { type: 'toolcall_end', contentIndex: 0 },
      { type: 'text_end', contentIndex: 0 },
      { type: 'thinking_end', contentIndex: 0 },
      { type: 'done', reason: 'stop' },
      { type: 'error', reason: 'aborted' },
    ]
    const event: Rpc.PiEvent = { type: 'message_update', assistantMessageEvent: deltas[0]! }
    expect(event).not.toHaveProperty('usage')
    expect(deltas).toHaveLength(7)
  })

  it('preserves nested tool IDs, optional duration and required settled.aborted', () => {
    type End = Extract<Rpc.PiEvent, { type: 'tool_execution_end' }>
    expectTypeOf<End['parentToolCallId']>().toEqualTypeOf<string | undefined>()
    expectTypeOf<End['durationMs']>().toEqualTypeOf<number | undefined>()
    expectTypeOf<Extract<Rpc.PiEvent, { type: 'agent_settled' }>>().toEqualTypeOf<{
      type: 'agent_settled'
      aborted: boolean
    }>()
    const events: Rpc.PiEvent[] = [
      {
        type: 'tool_execution_start',
        toolCallId: 'child',
        toolName: 'read',
        args: {},
        parentToolCallId: 'parent',
      },
      {
        type: 'tool_execution_update',
        toolCallId: 'child',
        toolName: 'read',
        args: {},
        partialResult: { content: [] },
        parentToolCallId: 'parent',
      },
      {
        type: 'tool_execution_end',
        toolCallId: 'child',
        toolName: 'read',
        result: { content: [] },
        isError: false,
        parentToolCallId: 'parent',
      },
      { type: 'agent_settled', aborted: true },
    ]
    expect(events[3]).toEqual({ type: 'agent_settled', aborted: true })
  })

  it('keeps every content, model and message export available at rpc.ts', () => {
    expectTypeOf<Rpc.ThinkingLevel>().toEqualTypeOf<
      'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
    >()
    expectTypeOf<Rpc.ThinkingLevelMap>().toEqualTypeOf<
      Partial<Record<Rpc.ThinkingLevel, string | null>>
    >()
    expectTypeOf<Rpc.StopReason>().toEqualTypeOf<
      'stop' | 'length' | 'toolUse' | 'error' | 'aborted'
    >()
    expectTypeOf<Rpc.AssistantContentBlock>().toEqualTypeOf<
      Rpc.TextContent | Rpc.ThinkingContent | Rpc.ToolCallContent
    >()
    expectTypeOf<Rpc.UserContentBlock>().toEqualTypeOf<Rpc.TextContent | Rpc.ImageContent>()
    expectTypeOf<Rpc.AgentMessage>().toEqualTypeOf<
      | Rpc.UserMessage
      | Rpc.AssistantMessage
      | Rpc.ToolResultMessage
      | Rpc.BashExecutionMessage
      | Rpc.CustomMessage
      | Rpc.BranchSummaryMessage
      | Rpc.CompactionSummaryMessage
    >()
    expectTypeOf<Rpc.Model['cost']>().toEqualTypeOf<Rpc.ModelCost>()
    expectTypeOf<Rpc.AssistantMessage['usage']>().toEqualTypeOf<Rpc.Usage | undefined>()
    expectTypeOf<Rpc.ToolPartialResult['content']>().toEqualTypeOf<
      (Rpc.TextContent | Rpc.ImageContent)[]
    >()
    expectTypeOf<Rpc.CompactionReason>().toEqualTypeOf<'manual' | 'threshold' | 'overflow'>()
    expectTypeOf<Rpc.RpcSlashCommand['sourceInfo']>().toEqualTypeOf<Rpc.SourceInfo | undefined>()
    expectTypeOf<Rpc.RpcResponse<string>>().toEqualTypeOf<
      Rpc.RpcSuccessResponse<string> | Rpc.RpcErrorResponse
    >()
  })

  it('preserves extension dialogs, state requests and reply shapes', () => {
    expectTypeOf<Rpc.ExtensionUIRequest['method']>().toEqualTypeOf<
      | 'select'
      | 'confirm'
      | 'input'
      | 'editor'
      | 'notify'
      | 'setStatus'
      | 'setWidget'
      | 'setTitle'
      | 'set_editor_text'
    >()
    expectTypeOf<Rpc.ExtensionUIResponse>().toEqualTypeOf<
      | { type: 'extension_ui_response'; id: string; value: string }
      | { type: 'extension_ui_response'; id: string; confirmed: boolean }
      | { type: 'extension_ui_response'; id: string; cancelled: true }
    >()
    const requests: Rpc.ExtensionUIRequest[] = [
      {
        type: 'extension_ui_request',
        id: '1',
        method: 'select',
        title: 'Choose',
        options: ['yes'],
        timeout: 100,
      },
      {
        type: 'extension_ui_request',
        id: '2',
        method: 'confirm',
        title: 'Confirm',
        message: 'OK?',
        timeout: 100,
      },
      {
        type: 'extension_ui_request',
        id: '3',
        method: 'input',
        title: 'Name',
        placeholder: 'name',
        timeout: 100,
      },
      { type: 'extension_ui_request', id: '4', method: 'editor', title: 'Edit', prefill: 'text' },
      {
        type: 'extension_ui_request',
        id: '5',
        method: 'notify',
        message: 'Done',
        notifyType: 'info',
      },
      {
        type: 'extension_ui_request',
        id: '6',
        method: 'setStatus',
        statusKey: 'key',
        statusText: undefined,
      },
      {
        type: 'extension_ui_request',
        id: '7',
        method: 'setWidget',
        widgetKey: 'key',
        widgetLines: undefined,
        widgetPlacement: 'belowEditor',
      },
      { type: 'extension_ui_request', id: '8', method: 'setTitle', title: 'Title' },
      { type: 'extension_ui_request', id: '9', method: 'set_editor_text', text: 'Draft' },
    ]
    expect(requests.map((request) => request.method)).toEqual([
      'select',
      'confirm',
      'input',
      'editor',
      'notify',
      'setStatus',
      'setWidget',
      'setTitle',
      'set_editor_text',
    ])
  })
})
